"""训练并对比旅行推荐排序模型。"""
import copy
import hashlib
import json
import os
from pathlib import Path
import random
import sys
import time
import torch
from torch.nn import functional as F
from experiment_unisrec import validate_input, ranking_metrics, baseline_scores, peak_rss_mib
from analyze_unisrec import paired_interval, strata
from lib.travel_rankers import DINRanker, DCNv2Ranker

ROOT = Path(__file__).resolve().parent.parent/'validation'/'travel-models'
CONFIG = {'epochs':12,'batch':32,'learningRate':.0003,'seeds':[20261018,20261019,20261020],
          'models':['din','dcn-v2'],'width':64,'threads':2,'objective':'weighted BCE',
          'selection':'best epoch per seed on validation every 3 epochs; report all seeds; no test tuning',
          'activationAllowed':False}


def batch_inputs(rows, items, profiles):
    history = torch.zeros(len(rows), max(1, max(len(r['history']) for r in rows)), items.shape[1])
    mask = torch.zeros(history.shape[:2], dtype=torch.bool)
    for i, row in enumerate(rows):
        n=len(row['history'])
        if n:
            history[i,:n]=items[row['history']]
            mask[i,:n]=True
    return profiles[[r['profile'] for r in rows]], items[[r['post'] for r in rows]], history, mask


@torch.no_grad()
def predict(model, rows, items, profiles):
    model.eval();scores=[]
    for start in range(0,len(rows),CONFIG['batch']):
        scores.extend(model(*batch_inputs(rows[start:start+CONFIG['batch']],items,profiles)).tolist())
    return scores


def main():
    if sys.argv[1:]!=['--local'] or os.getenv('NODE_ENV')=='production':raise SystemExit('Only --local allowed')
    ROOT.mkdir(parents=True,exist_ok=True)
    target=ROOT/'rankers-report.json'
    if target.exists():raise RuntimeError('Preserve existing experimental evidence')
    torch.set_num_threads(2);torch.set_num_interop_threads(1);torch.use_deterministic_algorithms(True)
    raw=(ROOT.parent/'unisrec/input.json').read_bytes();data=json.loads(raw);validate_input(data)
    (ROOT/'rankers-config.json').write_text(json.dumps(CONFIG,indent=2),encoding='utf8')
    items=torch.tensor([p['features'] for p in data['posts']]);profiles=torch.tensor([p['features'] for p in data['profiles']])
    groups={k:[r for r in data['rows'] if r['partition']==k] for k in ['train','validation','test']}
    base={k:baseline_scores(rows,data) for k,rows in groups.items()}
    started=time.monotonic()
    report={'status':'training','scope':'local synthetic','activationAllowed':False,'config':CONFIG,
            'inputSha256':hashlib.sha256(raw).hexdigest(),'datasetDigest':data['datasetDigest'],
            'sourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'coreSha256':hashlib.sha256((Path(__file__).parent/'lib/travel_rankers.py').read_bytes()).hexdigest(),
            'baseline':{k:ranking_metrics(groups[k],base[k]) for k in ['validation','test']},'trials':[],
            'limitation':'Previously inspected synthetic labels biased toward rule cosine; user-pooled diagnostic ranking; not an online qualification.'}
    def save():
        report.update(elapsedSeconds=round(time.monotonic()-started,2),peakRssMiB=peak_rss_mib())
        target.write_text(json.dumps(report,indent=2),encoding='utf8')
    save()
    try:
        for name in CONFIG['models']:
            for seed in CONFIG['seeds']:
                start=time.monotonic();torch.manual_seed(seed);rng=random.Random(seed)
                model={'din':DINRanker,'dcn-v2':DCNv2Ranker}[name]()
                optimizer=torch.optim.AdamW(model.parameters(),lr=CONFIG['learningRate'],weight_decay=.0001)
                trial={'name':name,'seed':seed,'pretrainedParameters':0,'parameters':sum(p.numel() for p in model.parameters()),'checkpoints':[]}
                best=None
                for epoch in range(1,CONFIG['epochs']+1):
                    order=list(range(len(groups['train'])));rng.shuffle(order);model.train()
                    for offset in range(0,len(order),CONFIG['batch']):
                        rows=[groups['train'][i] for i in order[offset:offset+CONFIG['batch']]]
                        labels=torch.tensor([r['label'] for r in rows],dtype=torch.float32)
                        weights=torch.tensor([min(5,max(.1,r['weight'])) for r in rows])
                        optimizer.zero_grad(set_to_none=True)
                        logits=model(*batch_inputs(rows,items,profiles))
                        loss=(F.binary_cross_entropy_with_logits(logits,labels,reduction='none')*weights).sum()/weights.sum()
                        if not torch.isfinite(loss):raise RuntimeError('Nonfinite loss')
                        loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1);optimizer.step()
                    if epoch%3==0:
                        metric=ranking_metrics(groups['validation'],predict(model,groups['validation'],items,profiles))
                        trial['checkpoints'].append({'epoch':epoch,'validation':metric})
                        if best is None or metric['ndcgAtK']>best['validation']['ndcgAtK']:
                            best={'epoch':epoch,'validation':metric,'state':copy.deepcopy(model.state_dict())}
                        print(json.dumps({'model':name,'seed':seed,'epoch':epoch,'validationNdcg':metric['ndcgAtK']}),flush=True)
                checkpoint=ROOT/(name+'-'+str(seed)+'.pt')
                torch.save({'activationAllowed':False,'state_dict':best['state'],'epoch':best['epoch'],'inputSha256':report['inputSha256']},checkpoint)
                model.load_state_dict(best['state'],strict=True)
                trial.update(selectedEpoch=best['epoch'],validation=best['validation'],trainingSeconds=round(time.monotonic()-start,2))
                t=time.monotonic();scores=predict(model,groups['test'],items,profiles)
                trial.update(test=ranking_metrics(groups['test'],scores),testInferenceMs=round((time.monotonic()-t)*1000,2),
                             pairedInterval=paired_interval(groups['test'],scores,base['test']),strata=strata(groups['test'],scores,base['test']))
                trial['passesHistoricalThreshold']=trial['validation']['ndcgAtK']>report['baseline']['validation']['ndcgAtK']+.005 and trial['test']['ndcgAtK']>report['baseline']['test']['ndcgAtK']+.005
                report['trials'].append(trial);save()
        report['status']='completed';save()
        print(json.dumps({'status':report['status'],'elapsedSeconds':report['elapsedSeconds'],'peakRssMiB':report['peakRssMiB'],'activationAllowed':False}),flush=True)
    except BaseException as e:
        report.update(status='failed',error=str(e));save();raise


if __name__=='__main__':main()
