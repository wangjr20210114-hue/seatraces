"""Apply the explicitly approved 3-place batch on its database host; backup first."""
from pathlib import Path
from datetime import datetime,timezone,timedelta
import importlib.util,json,shutil,subprocess,sys,time,urllib.request
ROOT=Path('/home/ubuntu/seatraces-osm')
STAGED=Path(__file__).resolve().parent
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def main():
    if not (ROOT/'database.json').is_file():raise ValueError('Expected database host')
    importer=load('batch_importer',STAGED/'import_annotations.py')
    payload=json.loads((STAGED/'official-three-20261011.json').read_text())
    importer.validate(payload)
    if len(payload['facts'])!=10 or len({r['placeId'] for r in payload['facts']})!=3:raise ValueError('Unexpected batch size')
    reader=load('new_reader',STAGED/'place_service.py')
    first=payload['facts'][0]
    sample={'value':first['value'],'source_name':first['sourceName'],'source_url':first['sourceUrl'],
      'source_timestamp':first['sourceTimestamp'],'recorded_at':first['verifiedAt'],'verified_at':first['verifiedAt'],'evidence':first['evidence']}
    assert reader.editorial_fact(sample)['status']=='evidence_reviewed'
    assert reader.editorial_fact(sample,datetime.now(timezone.utc)+timedelta(days=2))['value'] is None
    target=ROOT/'scripts/osm/place_service.py'
    if not target.is_file():raise ValueError('Existing reader not found')
    backup=ROOT/'backups'/('reader-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.py')
    backup.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,backup)
    result=importer.apply(payload)
    shutil.copy2(STAGED/'place_service.py',target)
    try:
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],check=True,capture_output=True)
        summaries=[]
        for place_id in sorted({r['placeId'] for r in payload['facts']}):
            item=None
            for attempt in range(5):
                try:
                    with urllib.request.urlopen('http://127.0.0.1:8791/place?id='+place_id,timeout=5) as r:item=json.load(r)['item']
                    break
                except OSError:
                    if attempt==4:raise
                    time.sleep(.4)
            expected=[r for r in payload['facts'] if r['placeId']==place_id]
            for row in expected:
                actual=item['facts'][row['field']]
                assert actual['value']==row['value'] and actual['status']=='evidence_reviewed'
                assert actual['evidence']['sourceHash']==row['evidence']['sourceHash']
            summaries.append({'placeId':place_id,'name':item['name'],'factsVerified':len(expected)})
        result.update({'places':summaries,'readerBackup':str(backup),'readerActive':True,'verifiedAt':datetime.now(timezone.utc).isoformat()})
        (STAGED/'receipt.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(result,ensure_ascii=False,indent=2))
    except Exception:
        shutil.copy2(backup,target)
        subprocess.run(['sudo','-n','systemctl','restart','seatraces-osm-catalog.service'],capture_output=True)
        raise RuntimeError('Reader restored; committed public fact batch is retained with provenance. Inspect before rerun.') from None
if __name__=='__main__':main()
