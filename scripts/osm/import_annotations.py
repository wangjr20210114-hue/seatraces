"""校验并导入有来源依据的地点补充资料。"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from uuid import uuid5,NAMESPACE_URL

ROOT=Path('/home/ubuntu/seatraces-osm')
FIELDS={'openingHours','lastEntry','ticketPrice','reservation','website','phone','wheelchair','checkIn','checkOut','address','stayMinutes','access'}
def validate(data):
    if not isinstance(data,dict) or set(data)-{'aliases','facts'}:raise ValueError('Expected aliases/facts document')
    aliases,facts=data.get('aliases',[]),data.get('facts',[])
    if not isinstance(aliases,list) or not isinstance(facts,list) or len(aliases)+len(facts)>500:raise ValueError('Maximum 500 records')
    for row in aliases+facts:
        if not isinstance(row,dict) or not re.fullmatch(r'osm:(node|way|relation)/[0-9]{1,20}',str(row.get('placeId',''))):raise ValueError('Invalid OSM ID')
        u=urlsplit(str(row.get('sourceUrl','')))
        if u.scheme not in ('https','http') or not u.hostname or u.username or u.password:raise ValueError('Source URL required')
        if not isinstance(row.get('sourceName'),str) or not 1<=len(row['sourceName'])<=200:raise ValueError('Source name required')
    for row in aliases:
        if not isinstance(row.get('alias'),str) or not 1<=len(row['alias'].strip())<=120:raise ValueError('Invalid alias')
        if not re.fullmatch(r'[A-Za-z-]{2,20}',str(row.get('language',''))):raise ValueError('Language code required')
    for row in facts:
        if row.get('field') not in FIELDS or row.get('value') is None:raise ValueError('Supported field and non-null value required')
        for key in ('sourceTimestamp','verifiedAt'):
            if key=='verifiedAt' and not row.get(key):continue
            d=datetime.fromisoformat(str(row.get(key,'')).replace('Z','+00:00'))
            if d.tzinfo is None or d>datetime.now(timezone.utc):raise ValueError('Source dates must be zoned and not in the future')
        v=row['value']
        if row['field']=='ticketPrice':
            if not isinstance(v,dict) or isinstance(v.get('amount'),bool) or not isinstance(v.get('amount'),(int,float)) or not 0<=v['amount']<=1000000 or not re.fullmatch('[A-Z]{3}',str(v.get('currency',''))):raise ValueError('Price requires amount and ISO currency')
        elif row['field']=='stayMinutes':
            if type(v)!=int or not 1<=v<=1440:raise ValueError('Invalid visit duration')
        elif not isinstance(v,str) or not 1<=len(v)<=2000:raise ValueError('Expected bounded text value')
        evidence=row.get('evidence')
        if evidence is not None:
            if not isinstance(evidence,dict) or evidence.get('version')!=1 or evidence.get('reviewStatus')!='accepted':raise ValueError('Evidence requires explicit review')
            if not isinstance(evidence.get('quote'),str) or not 6<=len(evidence['quote'])<=1800:raise ValueError('Evidence quote required')
            if not re.fullmatch('[a-f0-9]{64}',str(evidence.get('sourceHash',''))):raise ValueError('Source hash required')
            if not row.get('verifiedAt'):raise ValueError('Evidence review time required')
            dates={}
            for key in ('retrievedAt','reviewAfter','validFrom','validThrough'):
                if evidence.get(key) is None and key.startswith('valid'):continue
                d=datetime.fromisoformat(str(evidence.get(key,'')).replace('Z','+00:00'))
                if d.tzinfo is None:raise ValueError('Evidence dates require time zone')
                dates[key]=d
            now=datetime.now(timezone.utc)
            if dates['retrievedAt']>now or dates['reviewAfter']<=now or dates['reviewAfter']<=dates['retrievedAt']:raise ValueError('Evidence retrieval/review deadline invalid')
            if dates.get('validThrough',now)<now:raise ValueError('Expired evidence cannot be imported as current')
            if 'validFrom' in dates and 'validThrough' in dates and dates['validFrom']>dates['validThrough']:raise ValueError('Reversed validity range')
    return aliases,facts

def apply(data):
    aliases,facts=validate(data)
    sys.path.insert(0,str(ROOT/'.deps'))
    import psycopg
    from psycopg.types.json import Jsonb
    with psycopg.connect(**json.loads((ROOT/'database.json').read_text())) as c:
        backup=ROOT/'backups'/('editorial-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.json')
        backup.parent.mkdir(parents=True,exist_ok=True)
        snapshot={}
        for table in ('editorial_aliases','place_facts'):
            exists=c.execute('SELECT to_regclass(%s)',('osm.'+table,)).fetchone()[0]
            snapshot[table]=[r[0] for r in c.execute('SELECT to_jsonb(t) FROM osm.'+table+' t').fetchall()] if exists else []
        backup.write_text(json.dumps(snapshot,ensure_ascii=False,default=str),encoding='utf8')
        c.execute(Path(__file__).with_name('annotations.sql').read_text())
        for row in aliases+facts:
            if not c.execute('SELECT 1 FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id WHERE p.id=%s LIMIT 1',(row['placeId'],)).fetchone():raise ValueError('An annotated OSM object is absent from active imports')
        for row in aliases:
            c.execute('INSERT INTO osm.editorial_aliases(place_id,alias,language,source_name,source_url) VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                (row['placeId'],row['alias'].strip(),row['language'],row['sourceName'],row['sourceUrl']))
        inserted=0
        for row in facts:
            identifier=uuid5(NAMESPACE_URL,json.dumps(row,ensure_ascii=False,sort_keys=True))
            inserted+=c.execute('INSERT INTO osm.place_facts(id,place_id,field,value,source_name,source_url,source_timestamp,verified_at,evidence) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                (identifier,row['placeId'],row['field'],Jsonb(row['value']),row['sourceName'],row['sourceUrl'],row['sourceTimestamp'],row.get('verifiedAt'),Jsonb(row.get('evidence',{})))).rowcount
    return {'aliases':len(aliases),'facts':len(facts),'insertedFacts':inserted,'backup':str(backup),'mode':'applied','note':'Duplicate records are idempotent; source OSM snapshots preserved.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file',type=Path);parser.add_argument('--apply',action='store_true')
    args=parser.parse_args();data=json.loads(args.file.read_text(encoding='utf8'));aliases,facts=validate(data)
    print(json.dumps(apply(data) if args.apply else {'mode':'validated_only','aliases':len(aliases),'facts':len(facts)}))
