"""Predeclared small CPU ranking experiments. Not a two-tower activation path."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import lightgbm as lgb
import numpy as np
from lib.ranking_diagnostic import row_features,initial_score,metrics,grouped_rows,paired_interval,peak_rss_mib

ROOT=Path(__file__).resolve().parent.parent/'validation/ranking-diagnostic'
CONFIG={'rounds':100,'checkpointEvery':10,'threads':2,'seeds':[20261018,20261019,20261020],
 'trials':[{'name':'binary-rules','rich':False,'target':'label'}, {'name':'binary-rich','rich':True,'target':'label'}, {'name':'graded-rich','rich':True,'target':'grade'}],
 'parameters':{'objective':'lambdarank','metric':'None','learning_rate':.03,'num_leaves':7,'max_depth':3,'min_data_in_leaf':40,
  'lambda_l2':5,'feature_fraction':.9,'bagging_fraction':.8,'bagging_freq':1,'max_bin':63,'label_gain':[0,1,2,3,4],
  'lambdarank_truncation_level':13,'deterministic':True,'force_col_wise':True,'num_threads':2,'verbosity':-1},
 'selection':'per seed: validation-only checkpoints including untouched rule at iteration 0; historical test reported after freeze',
 'scope':'local synthetic user-pooled diagnostic', 'activationAllowed':False}

def main():
 if sys.argv[1:]!=['--local'] or os.getenv('NODE_ENV')=='production':raise SystemExit('Only --local')
 if lgb.__version__!='4.6.0':raise RuntimeError('Use pinned LightGBM 4.6.0')
 target=ROOT/'report.json'
 if target.exists():raise RuntimeError('Preserve prior result')
 raw=(ROOT/'input.json').read_bytes();d=json.loads(raw);semantic_raw=(ROOT.parent/'unisrec/input.json').read_bytes();data=json.loads(semantic_raw)
 if d['scope']!='local synthetic' or d['activationAllowed'] is not False or d['inputSha256']!=hashlib.sha256(semantic_raw).hexdigest():raise ValueError('Input mismatch')
 if len(d['rows'])!=len(data['rows']) or len(d['rows'])>5000:raise ValueError('Input bound')
 for r,old in zip(d['rows'],data['rows']):
  if any(r[k]!=old[k] for k in old):raise ValueError('Frozen row changed')
  if r['partition']=='train' and r['at']+7*86400000>=data['cutoff']:raise ValueError('Temporal overlap')
 (ROOT/'config.json').write_text(json.dumps(CONFIG,indent=2),encoding='utf8')
 started=time.monotonic();groups={k:grouped_rows([r for r in d['rows'] if r['partition']==k]) for k in ['train','validation','test']}
 report={'status':'training','config':CONFIG,'inputSha256':hashlib.sha256(raw).hexdigest(),'activationAllowed':False,
  'sourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'coreSha256':hashlib.sha256((Path(__file__).parent/'lib/ranking_diagnostic.py').read_bytes()).hexdigest(),
  'requestAudit':d['requestAudit'],'baseline':{},'trials':[],
  'limitation':'Previously inspected synthetic labels favor cosine. Every original request is singleton; all LTR groups explicitly pool a user across historical requests. This is not a feed experiment.'}
 def save():
  report.update(elapsedSeconds=round(time.monotonic()-started,3),peakRssMiB=round(peak_rss_mib(),2))
  target.write_text(json.dumps(report,indent=2),encoding='utf8')
 for part in ['validation','test']:
  rows,_=groups[part];report['baseline'][part]={}
  for name,fn in [('cosine',lambda r:r['parts']['affinity']),('existingFineRule',initial_score)]:
   report['baseline'][part][name]={label:metrics(rows,[fn(r) for r in rows],label) for label in ['label','grade']}
  report['baseline'][part]['perRequest']=metrics(rows,[initial_score(r) for r in rows],group_key='requestId')
 save()
 try:
  for trial in CONFIG['trials']:
   matrices={part:np.asarray([row_features(r,data,trial['rich'])[1] for r in rs],dtype=np.float64) for part,(rs,_) in groups.items()}
   names=row_features(groups['train'][0][0],data,trial['rich'])[0]
   init={part:np.asarray([initial_score(r) for r in rs]) for part,(rs,_) in groups.items()}
   label=trial['target']
   for seed in CONFIG['seeds']:
    t=time.monotonic();params={**CONFIG['parameters'],'seed':seed,'feature_fraction_seed':seed,'bagging_seed':seed}
    train=lgb.Dataset(matrices['train'],label=[r[label] for r in groups['train'][0]],group=groups['train'][1],init_score=init['train'],feature_name=names)
    checks=[{'iteration':0,'ndcg':metrics(groups['validation'][0],init['validation'],label)['ndcgAtK']}]
    def observe(env):
     if (env.iteration+1)%CONFIG['checkpointEvery']==0:
      scores=init['validation']+env.model.predict(matrices['validation'],num_iteration=env.iteration+1)
      checks.append({'iteration':env.iteration+1,'ndcg':metrics(groups['validation'][0],scores,label)['ndcgAtK']})
    model=lgb.train(params,train,num_boost_round=CONFIG['rounds'],callbacks=[observe])
    best=max(checks,key=lambda r:r['ndcg']);iteration=best['iteration']
    name=trial['name']+'-'+str(seed)
    if iteration:model.save_model(str(ROOT/(name+'.txt')),num_iteration=iteration)
    result={'name':trial['name'],'seed':seed,'features':len(names),'target':label,'checkpoints':checks,'selectedIteration':iteration,
     'ruleFallbackSelected':iteration==0,'trainingSeconds':round(time.monotonic()-t,3),'partitions':{}}
    for part in ['validation','test']:
     t1=time.monotonic();scores=init[part]+(model.predict(matrices[part],num_iteration=iteration) if iteration else 0)
     result['partitions'][part]={'metrics':{label2:metrics(groups[part][0],scores,label2) for label2 in ['label','grade']},
      'inferenceMs':round((time.monotonic()-t1)*1000,2),'rows':len(scores)}
     if part=='test':
      result['partitions'][part]['deltaVsCosine']=paired_interval(groups[part][0],scores,[r['parts']['affinity'] for r in groups[part][0]],label)
      result['partitions'][part]['deltaVsFineRule']=paired_interval(groups[part][0],scores,init[part],label)
    # Serialized LightGBM excludes init_score. Verify our explicit addition.
    if iteration:
     reloaded=lgb.Booster(model_file=str(ROOT/(name+'.txt')))
     assert np.allclose(init['test']+reloaded.predict(matrices['test']),init['test']+model.predict(matrices['test'],num_iteration=iteration))
    report['trials'].append(result);save()
    print(json.dumps({'trial':name,'selectedIteration':iteration,'validation':result['partitions']['validation']['metrics'],'test':result['partitions']['test']['metrics']}),flush=True)
  report['status']='completed';save()
  print(json.dumps({'status':report['status'],'elapsedSeconds':report['elapsedSeconds'],'peakRssMiB':report['peakRssMiB'],'activationAllowed':False}),flush=True)
 except BaseException as e:
  report.update(status='failed',error=str(e));save();raise

if __name__=='__main__':main()
