"""固定排序模型预测结果，供后续人工评审使用。"""
import hashlib
import json
import os
from pathlib import Path
import sys
import lightgbm as lgb
import numpy as np
from lib.ranking_diagnostic import row_features,initial_score,cosine,metrics,grouped_rows

def main():
 if sys.argv[1:]!=['--local'] or os.getenv('NODE_ENV')=='production':raise SystemExit('Only --local')
 root=Path(__file__).resolve().parent.parent/'validation';folder=root/'graded-preference-review';target=folder/'scores-private.json'
 if target.exists():raise RuntimeError('Keep frozen predictions')
 if any((folder/'answers').glob('*.json')):raise RuntimeError('Predictions must be frozen before answers arrive')
 raw=(root/'ranking-diagnostic/input.json').read_bytes();source=json.loads(raw)
 report=json.loads((root/'ranking-diagnostic/report.json').read_text(encoding='utf8'))
 semantic_raw=(root/'unisrec/input.json').read_bytes();data=json.loads(semantic_raw)
 protocol=json.loads((folder/'protocol-private.json').read_text(encoding='utf8'))
 if report['status']!='completed' or report['activationAllowed'] is not False or report['inputSha256']!=hashlib.sha256(raw).hexdigest() or source['inputSha256']!=hashlib.sha256(semantic_raw).hexdigest() or protocol['inputSha256']!=report['inputSha256']:raise ValueError('Input mismatch')
 best=max((t for t in report['trials'] if t['target']=='label'),key=lambda t:t['partitions']['validation']['metrics']['label']['ndcgAtK'])
 iteration=best['selectedIteration'];rich=best['name'].endswith('rich')
 modelpath=root/'ranking-diagnostic'/(best['name']+'-'+str(best['seed'])+'.txt')
 model=lgb.Booster(model_file=str(modelpath)) if iteration else None
 validation,_=grouped_rows([r for r in source['rows'] if r['partition']=='validation'])
 x=np.asarray([row_features(r,data,rich)[1] for r in validation]);scores=np.asarray([initial_score(r) for r in validation])+(model.predict(x,num_threads=2) if model else 0)
 if abs(metrics(validation,scores)['ndcgAtK']-best['partitions']['validation']['metrics']['label']['ndcgAtK'])>1e-10:raise ValueError('Frozen validation replay differs')
 rows=[];probes=[p for p in protocol['probes'] if not p.get('repeatOf')]
 for probe in probes:
  u=next(r for r in source['rows'] if r['profile']==probe['profile'])['userVector'];v=next(r for r in source['rows'] if r['postId']==probe['postId'])
  affinity=cosine(u,v['itemVector']);quality=v['parts']['quality']
  rows.append({'profile':probe['profile'],'post':probe['postIndex'],'userVector':u,'itemVector':v['itemVector'],'history':[],'historyWindowEnds':[],'at':0,
   'parts':{'affinity':affinity,'quality':quality,'author':0,'city':0,'fresh':0,'seen':0,'tower':0,'coarse':affinity*3+quality*.2}})
 predictions=np.asarray([initial_score(r) for r in rows])+(model.predict(np.asarray([row_features(r,data,rich)[1] for r in rows]),num_threads=2) if model else 0)
 result={'protocolId':protocol['protocolId'],'activationAllowed':False,'selection':'highest validation binary NDCG among predeclared binary trials; no test or human answer selection',
  'selected':{'name':best['name'],'seed':best['seed'],'iteration':iteration,'weightsSha256':hashlib.sha256(modelpath.read_bytes()).hexdigest() if model else None},
  'context':'Supplied scenario only. No reviewer history. Author, city, freshness and seen context unavailable: all zero for every method. This is a different population from historical exposures.',
  'evaluationPlan':'Compare each read/save/adopt dimension separately, no=0/maybe=1/yes=2; unknown excluded, not negative. Group by reviewer+scenario and report random and disagreement strata separately. Exclude repeats. Minimum two rated candidates and positive gain per group. No automatic activation or inferential population claim.',
  'predictions':[{ 'taskId':p['taskId'],'scores':{'cosine':r['parts']['affinity'],'fineRule':initial_score(r),'lightgbm':float(score),'bgeSmall':cosine(data['profiles'][r['profile']]['features'][96:],data['posts'][r['post']]['features'][96:])}} for p,r,score in zip(probes,rows,predictions)]}
 with target.open('x',encoding='utf8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
 print(json.dumps({'frozen':True,'tasks':len(probes),'selected':result['selected'],'answersRead':0,'activationAllowed':False}))

if __name__=='__main__':main()
