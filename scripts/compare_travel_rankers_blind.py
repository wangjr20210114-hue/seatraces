"""Frozen validation-selected seed/epoch; no training on human preferences."""
import hashlib
import json
import os
from pathlib import Path
import sys
import torch
from experiment_travel_rankers import ROOT, predict
from lib.travel_rankers import DINRanker, DCNv2Ranker


def main():
    if sys.argv[1:]!=['--local'] or os.getenv('NODE_ENV')=='production':raise SystemExit('Only --local')
    torch.set_num_threads(2)
    raw=(ROOT.parent/'unisrec/input.json').read_bytes();data=json.loads(raw)
    report=json.loads((ROOT/'blind-semantic.json').read_text(encoding='utf8'))
    training=json.loads((ROOT/'rankers-report.json').read_text(encoding='utf8'))
    if report['inputSha256']!=hashlib.sha256(raw).hexdigest() or training['inputSha256']!=report['inputSha256']:raise ValueError('Input changed')
    if training['status']!='completed' or training['activationAllowed'] is not False:raise ValueError('Not an offline completed run')
    items=torch.tensor([p['features'] for p in data['posts']]);profiles=torch.tensor([p['features'] for p in data['profiles']])
    pairs=[r for r in report['results'] if type(r['outcome']) is int]
    rows=[{'profile':r['profile'],'post':p,'history':[]} for r in pairs for p in r['posts']]
    out={'activationAllowed':False,'analysisTiming':'post_hoc','history':'No real reviewer history; supplied scenario only.', 'models':{}}
    for name,cls in [('din',DINRanker),('dcn-v2',DCNv2Ranker)]:
        best=max((t for t in training['trials'] if t['name']==name),key=lambda t:t['validation']['ndcgAtK'])
        saved=torch.load(ROOT/(name+'-'+str(best['seed'])+'.pt'),map_location='cpu',weights_only=True)
        if saved['activationAllowed'] is not False or saved['epoch']!=best['selectedEpoch'] or saved['inputSha256']!=report['inputSha256']:raise ValueError('Frozen weights mismatch')
        model=cls();model.load_state_dict(saved['state_dict'],strict=True)
        scores=predict(model,rows,items,profiles);matched=tied=0
        for i,r in enumerate(pairs):
            a,b=scores[2*i:2*i+2]
            tied+=abs(a-b)<=1e-9
            matched+=(a>b+1e-9 if r['outcome']==0 else b>a+1e-9)
        out['models'][name]={'seed':best['seed'],'epoch':best['selectedEpoch'],'matched':matched,'tied':tied,'total':len(pairs),'selection':'validation only'}
    target=ROOT/'blind-rankers.json'
    with target.open('x',encoding='utf8') as f:json.dump(out,f,indent=2)
    print(json.dumps(out))


if __name__=='__main__':main()
