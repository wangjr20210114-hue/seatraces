"""安装故宫地点资料批次并检查查询服务。"""
from pathlib import Path
from datetime import datetime,timezone
import json,shutil,subprocess,time,urllib.request
from apply_scenic_batch import ROOT,apply,validate
STAGED=Path(__file__).resolve().parent

def get(path):
    with urllib.request.urlopen('http://127.0.0.1:8791'+path,timeout=20) as r:return json.load(r)

def main():
    batch=json.loads((STAGED/'palace-20261012.json').read_text(encoding='utf8'));validate(batch)
    replacements=['place_service.py','cluster_catalog.py']
    backup=ROOT/'backups'/('palace-reader-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(parents=True,exist_ok=False)
    for name in replacements:
        target=ROOT/'scripts/osm'/name
        if not target.is_file():raise ValueError('Expected existing reader module missing')
        compile((STAGED/name).read_text(encoding='utf8'),name,'exec')
        shutil.copy2(target,backup/name)
    applied=apply(batch)
    try:
        for name in replacements:shutil.copy2(STAGED/name,ROOT/'scripts/osm'/name)
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],check=True,capture_output=True,timeout=30)
        for attempt in range(5):
            try:
                health=get('/health');break
            except OSError:
                if attempt==4:raise
                time.sleep(.4)
        if health.get('version')!=6 or health.get('readOnly') is not True:raise ValueError('Reader health mismatch')
        ids=sorted(set([r[k] for r in batch['relations'] for k in ('childId','parentId')]+[r['placeId'] for r in batch['facts']]))
        checks=[]
        for place_id in ids:
            p=get('/place?id='+place_id)['item']
            for row in batch['facts']:
                if row['placeId']!=place_id:continue
                f=p['facts'][row['field']]
                if f['value']!=row['value'] or f['status']!='evidence_reviewed' or f['evidence']['sourceHash']!=row['evidence']['sourceHash']:raise ValueError('Fact readback failed')
            for row in batch['relations']:
                if row['childId']==place_id and p.get('parentId')!=row['parentId']:raise ValueError('Parent readback failed')
            checks.append(dict(id=place_id,name=p['name'],parentId=p.get('parentId')))
        points=get('/cluster-places?west=116.38&south=39.91&east=116.40&north=39.93')['items']
        linked=[p for p in points if p.get('parentId')=='osm:relation/9511883']
        if {p['id'] for p in linked}!={r['childId'] for r in batch['relations']}:raise ValueError('Cluster relationship readback mismatch')
        result=dict(applied,readerBackup=str(backup),readerVersion=6,checkedPlaces=checks,clusterLinkedCount=len(linked),verifiedAt=datetime.now(timezone.utc).isoformat())
        (STAGED/'receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(result,ensure_ascii=False))
    except Exception:
        for name in replacements:shutil.copy2(backup/name,ROOT/'scripts/osm'/name)
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],capture_output=True,timeout=30)
        raise RuntimeError('Reader restored; committed enrichment remains audited in separate tables. Check before retry.') from None

if __name__=='__main__':main()
