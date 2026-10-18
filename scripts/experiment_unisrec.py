"""CPU-only offline comparison; no database, network or activation commands."""
import copy
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sys
import time
import torch
from torch.nn import functional as F
from lib.unisrec_model import AdaptedUniSRec, read_checkpoint

ROOT = Path(__file__).resolve().parent.parent / 'validation' / 'unisrec'
CONFIGS = [
    {'name':'pretrained-frozen','pretrained':True,'freezeEncoder':True},
    {'name':'random-frozen','pretrained':False,'freezeEncoder':True},
    {'name':'random-trainable','pretrained':False,'freezeEncoder':False},
]
EPOCHS, BATCH, LR, SEED = 12, 32, 0.0003, 20261018


def peak_rss_mib():
    if os.name != 'nt':
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(value/(1048576 if sys.platform=='darwin' else 1024),2)
    class Counters(ctypes.Structure):
        _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong)]+[(name,ctypes.c_size_t) for name in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage']]
    api=ctypes.windll.psapi.GetProcessMemoryInfo
    api.argtypes=[ctypes.c_void_p,ctypes.POINTER(Counters),ctypes.c_ulong]
    api.restype=ctypes.c_int
    handle=ctypes.windll.kernel32.GetCurrentProcess
    handle.restype=ctypes.c_void_p
    out=Counters();out.cb=ctypes.sizeof(out)
    if not api(handle(),ctypes.byref(out),out.cb):
        raise OSError('Could not measure process memory')
    return round(out.PeakWorkingSetSize/1048576,2)


def ranking_metrics(rows,scores,k=10):
    if len(rows)!=len(scores) or any(not math.isfinite(float(x)) for x in scores):
        raise ValueError('Invalid prediction count or values')
    groups={}
    for row,score in zip(rows,scores):
        groups.setdefault(row['userId'],[]).append((row,float(score)))
    recall=ndcg=0.;count=0
    for group in groups.values():
        positives=sum(row['label']==1 for row,_ in group)
        if not positives:continue
        ranked=sorted(group,key=lambda x:-x[1])[:k]
        recall+=sum(row['label']==1 for row,_ in ranked)/positives
        dcg=sum(row['label']/math.log2(i+2) for i,(row,_) in enumerate(ranked))
        ideal=sum(1/math.log2(i+2) for i in range(min(k,positives)))
        ndcg+=dcg/ideal;count+=1
    return {'groups':count,'recallAtK':recall/count if count else 0,'ndcgAtK':ndcg/count if count else 0,'k':k}


def tensors_for(rows,items,profiles):
    lengths=torch.tensor([len(r['history'])+1 for r in rows],dtype=torch.long)
    sequence=torch.zeros(len(rows),int(lengths.max()),608)
    for i,row in enumerate(rows):
        n=len(row['history'])
        if n:sequence[i,:n]=items[row['history']]
        sequence[i,n]=profiles[row['profile']]
    candidates=items[[r['post'] for r in rows]]
    labels=torch.tensor([r['label'] for r in rows],dtype=torch.float32)
    weights=torch.tensor([max(.1,min(5,r['weight'])) for r in rows])
    return sequence,lengths,candidates,labels,weights


@torch.no_grad()
def predict(model,rows,items,profiles):
    model.eval();out=[]
    for start in range(0,len(rows),BATCH):
        batch=tensors_for(rows[start:start+BATCH],items,profiles)
        out.extend(model(*batch[:3]).tolist())
    return out


def baseline_scores(rows,data):
    result=[]
    for row in rows:
        u=data['profiles'][row['profile']]['features'][:96]
        v=data['posts'][row['post']]['features'][:96]
        denominator=math.sqrt(sum(x*x for x in u)*sum(x*x for x in v))
        result.append(sum(x*y for x,y in zip(u,v))/denominator if denominator else 0.)
    return result


def validate_input(data):
    if data.get('version')!='offline-unisrec-input/1' or data.get('scope')!='local synthetic' or data.get('activationAllowed') is not False:
        raise ValueError('Unrecognized local input scope')
    if not 300<=len(data['rows'])<=5000 or not 1<=len(data['posts'])<=1000 or not 1<=len(data['profiles'])<=100:
        raise ValueError('Offline input bounds exceeded')
    for x in data['posts']+data['profiles']:
        if len(x['features'])!=608 or any(not math.isfinite(v) for v in x['features']):raise ValueError('Invalid feature vector')
    seen=set()
    for row in data['rows']:
        if row['label'] not in (0,1) or not math.isfinite(row['weight']):raise ValueError('Invalid label')
        if not 0<=row['post']<len(data['posts']) or not 0<=row['profile']<len(data['profiles']):raise ValueError('Invalid item or profile index')
        if row['postId']!=data['posts'][row['post']]['id']:raise ValueError('Post identity mismatch')
        if len(row['history'])>20 or len(row['history'])!=len(row['historyWindowEnds']):raise ValueError('Invalid history length')
        if any(not 0<=i<len(data['posts']) for i in row['history']):raise ValueError('Invalid history index')
        if any(t>=row['at'] for t in row['historyWindowEnds']):raise ValueError('Future history leakage')
        if row['partition'] not in ('train','validation','test','embargo'):raise ValueError('Unknown partition')
        if row['partition']=='train' and row['at']+7*86400000>=data['cutoff']:raise ValueError('Training embargo violation')
        if row['partition']=='validation' and not (row['at']>=data['cutoff'] and row['at']+7*86400000<data['testStarts']):raise ValueError('Validation embargo violation')
        if row['partition']=='test' and row['at']<data['testStarts']:raise ValueError('Test time violation')
        identity=(row['userId'],row['postId'])
        if identity in seen:raise ValueError('Duplicate user/post pair')
        seen.add(identity)


def main():
    if sys.argv[1:]!=['--local'] or os.getenv('NODE_ENV')=='production':
        raise SystemExit('Only --local is accepted; this runner cannot activate or access production')
    if (ROOT/'report.json').exists():
        raise RuntimeError('Experiment report already exists; preserve its evidence')
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    started=time.monotonic();source=(ROOT/'input.json').read_bytes();data=json.loads(source)
    validate_input(data)
    state,loaded=read_checkpoint(ROOT/'UniSRec-FHCKM-300.pth')
    items=torch.tensor([p['features'] for p in data['posts']],dtype=torch.float32)
    profiles=torch.tensor([p['features'] for p in data['profiles']],dtype=torch.float32)
    partitions={name:[r for r in data['rows'] if r['partition']==name] for name in ['train','validation','test']}
    if len(partitions['train'])<150 or len(partitions['validation'])<50 or len(partitions['test'])<50:
        raise ValueError('Insufficient temporal coverage')
    base=ranking_metrics(partitions['validation'],baseline_scores(partitions['validation'],data))
    if abs(base['ndcgAtK']-data['baselineValidation']['ndcgAtK'])>1e-8:
        raise ValueError('Python evaluation does not match existing JS baseline: '+str(base))
    report={'algorithm':'offline-unisrec-adapter/1','scope':data['scope'],'status':'training','activationAllowed':False,
            'checkpoint':loaded,'inputSha256':hashlib.sha256(source).hexdigest(),'datasetDigest':data['datasetDigest'],
            'programSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'coreSha256':hashlib.sha256((Path(__file__).parent/'lib/unisrec_model.py').read_bytes()).hexdigest(),
            'torchVersion':torch.__version__,'device':'cpu','threads':2,'configurations':CONFIGS,'epochs':EPOCHS,'batchSize':BATCH,'learningRate':LR,'seed':SEED,
            'partitions':{k:len(v) for k,v in partitions.items()},'baselineValidation':base,
            'adaptation':'New normalized 608->768 bridge, explicit preference as final sequence token, weighted BCE instead of original next-item CE.',
            'evaluationLimit':data['evaluationLimit'],'trials':[]}
    def save():
        report['elapsedSeconds']=round(time.monotonic()-started,2);report['peakRssMiB']=peak_rss_mib()
        (ROOT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    save();selected=None
    try:
        for config in CONFIGS:
            torch.manual_seed(SEED);rng=random.Random(SEED)
            model=AdaptedUniSRec(state if config['pretrained'] else None,config['freezeEncoder'])
            transferred=sum(t.numel() for t in state.values()) if config['pretrained'] else 0
            trial={**config,'transferredParameters':transferred,'totalParameters':sum(p.numel() for p in model.parameters()),
                   'trainableParameters':sum(p.numel() for p in model.parameters() if p.requires_grad),'checkpoints':[]}
            optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=LR,weight_decay=0.0001)
            best=None;trial_started=time.monotonic()
            for epoch in range(1,EPOCHS+1):
                order=list(range(len(partitions['train'])));rng.shuffle(order);model.train();loss_sum=0.;weight_sum=0.
                for start in range(0,len(order),BATCH):
                    rows=[partitions['train'][i] for i in order[start:start+BATCH]]
                    sequence,lengths,candidates,labels,weights=tensors_for(rows,items,profiles)
                    optimizer.zero_grad(set_to_none=True)
                    logits=model(sequence,lengths,candidates)
                    losses=F.binary_cross_entropy_with_logits(logits,labels,reduction='none')
                    loss=(losses*weights).sum()/weights.sum()
                    if not torch.isfinite(loss):raise RuntimeError('Non-finite training loss')
                    loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.0);optimizer.step()
                    loss_sum+=float((losses.detach()*weights).sum());weight_sum+=float(weights.sum())
                if epoch%3==0:
                    scores=predict(model,partitions['validation'],items,profiles)
                    metrics=ranking_metrics(partitions['validation'],scores)
                    entry={'epoch':epoch,'loss':loss_sum/weight_sum,'validation':metrics}
                    trial['checkpoints'].append(entry)
                    if best is None or metrics['ndcgAtK']>best['validation']['ndcgAtK']:
                        best={**entry,'state':copy.deepcopy(model.state_dict())}
                    report['current']={'trial':config['name'],**entry};save()
                    print(json.dumps({'trial':config['name'],'epoch':epoch,'validationNdcg':metrics['ndcgAtK'],'peakRssMiB':report['peakRssMiB']}),flush=True)
            trial.update({'selectedEpoch':best['epoch'],'validation':best['validation'],'trainingSeconds':round(time.monotonic()-trial_started,2)})
            report['trials'].append(trial)
            if selected is None or best['validation']['ndcgAtK']>selected['validation']['ndcgAtK']:
                selected={**best,'configuration':config}
            save()
        # The model and epoch are frozen using validation before test scores.
        torch.save({'algorithm':'offline-unisrec-adapter/1','activationAllowed':False,'configuration':selected['configuration'],'epoch':selected['epoch'],
                    'state_dict':selected['state'],'inputSha256':report['inputSha256'],'checkpointSha256':loaded['sha256']},ROOT/'selected.pt')
        (ROOT/'selection.json').write_text(json.dumps({'configuration':selected['configuration'],'epoch':selected['epoch'],'validation':selected['validation'],'activationAllowed':False},indent=2))
        model=AdaptedUniSRec();model.load_state_dict(selected['state'],strict=True)
        inference_started=time.monotonic()
        test_scores=predict(model,partitions['test'],items,profiles)
        report['testInference']={'rows':len(test_scores),'batchSize':BATCH,'elapsedMs':round((time.monotonic()-inference_started)*1000,2),
                                 'scope':'Offline per-exposure sequence + candidate scoring; not production HTTP or full-catalog retrieval latency.'}
        baseline=baseline_scores(partitions['test'],data)
        report['selected']={'name':selected['configuration']['name'],'epoch':selected['epoch'],'validation':selected['validation'],
                            'test':ranking_metrics(partitions['test'],test_scores),'baselineTest':ranking_metrics(partitions['test'],baseline)}
        report['passesHistoricalThreshold']=selected['validation']['ndcgAtK']>base['ndcgAtK']+.005 and report['selected']['test']['ndcgAtK']>report['selected']['baselineTest']['ndcgAtK']+.005
        report['status']='completed';report.pop('current',None);save()
        print(json.dumps({'selected':report['selected'],'elapsedSeconds':report['elapsedSeconds'],'peakRssMiB':report['peakRssMiB'],'passesHistoricalThreshold':report['passesHistoricalThreshold'],'activationAllowed':False}),flush=True)
    except BaseException as error:
        report['status']='failed';report['error']=str(error);save();raise


if __name__=='__main__':
    main()
