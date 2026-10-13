"""Append one reviewed public batch transactionally, backing up affected editorial data."""
from pathlib import Path
from datetime import datetime,timezone
from uuid import uuid5,NAMESPACE_URL
import argparse,hashlib,json,re,sys

ROOT=Path('/home/ubuntu/seatraces-osm')
FIELDS={'openingHours','lastEntry','ticketPrice','reservation','phone','access','description'}
ID=re.compile(r'osm:(node|way|relation)/[0-9]{1,20}')
def date(value):
    d=datetime.fromisoformat(str(value).replace('Z','+00:00'))
    if not d.tzinfo:raise ValueError('Missing time zone')
    return d

def validate(data,now=None):
    now=now or datetime.now(timezone.utc)
    if data.get('version')!=1 or data.get('batchId')!='palace-20261012':raise ValueError('Unexpected pilot')
    if len(data.get('relations',[]))!=5 or len(data.get('facts',[]))!=9:raise ValueError('Unexpected batch counts')
    sources={s['id']:s for s in data['sources']};parents={};fact_keys=set()
    for row in data['relations']+data['facts']:
        ids=[row['childId'],row['parentId']] if 'childId' in row else [row['placeId']]
        if not all(ID.fullmatch(i) for i in ids):raise ValueError('Invalid place identity')
        e=row['evidence'];s=sources.get(e['evidenceId'])
        if not s or not s['text'].find(e['quote'])>=0:raise ValueError('Missing literal evidence')
        target=ids[0];field='relation' if 'childId' in row else row['field']
        if target not in s['placeIds'] or field not in s['fields']:raise ValueError('Evidence scope mismatch')
        if row['sourceUrl']!=s['url'] or e['sourceHash']!=s['sha256'] or not re.fullmatch('[a-f0-9]{64}',s['sha256']):raise ValueError('Evidence provenance mismatch')
        if not row['sourceUrl'].startswith('https://www.dpm.org.cn/'):raise ValueError('Unexpected publisher')
        if e['reviewStatus']!='accepted' or date(row['verifiedAt'])>now:raise ValueError('Review required')
        if date(e['retrievedAt'])>now or date(e['reviewAfter'])<=now:raise ValueError('Stale evidence')
        if row['sourceTimestamp'] is not None and date(row['sourceTimestamp'])>now:raise ValueError('Future publication date')
        if 'childId' in row:
            if row['type']!='part_of' or ids[0]==ids[1] or ids[0] in parents:raise ValueError('Invalid hierarchy')
            parents[ids[0]]=ids[1]
        else:
            key=(row['placeId'],field)
            if field not in FIELDS or key in fact_keys:raise ValueError('Invalid or duplicate field')
            fact_keys.add(key)
            if field=='ticketPrice':
                if row['value']['currency']!='CNY' or not 0<=row['value']['amount']<=1000000:raise ValueError('Invalid price')
            elif not isinstance(row['value'],str) or not 1<=len(row['value'])<=1500:raise ValueError('Invalid text')
    check_graph(parents)
    return parents

def check_graph(parents):
    for child in parents:
        seen={child};parent=parents[child]
        while parent:
            if parent in seen:raise ValueError('Cyclic hierarchy')
            seen.add(parent);parent=parents.get(parent)

def apply(data):
    parents=validate(data);sys.path.insert(0,str(ROOT/'.deps'))
    import psycopg
    from psycopg.types.json import Jsonb
    from psycopg.rows import dict_row
    payload_hash=hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    ids=sorted(set([r[k] for r in data['relations'] for k in ('childId','parentId')]+[r['placeId'] for r in data['facts']]))
    with psycopg.connect(**json.loads((ROOT/'database.json').read_text()),row_factory=dict_row) as c:
        c.execute('SELECT pg_advisory_xact_lock(20261012)')
        snapshot={}
        for table in ('place_facts','place_relationships','enrichment_batches'):
            exists=c.execute('SELECT to_regclass(%s) AS name',('osm.'+table,)).fetchone()['name']
            snapshot[table]=[r['data'] for r in c.execute('SELECT to_jsonb(t) AS data FROM osm.'+table+' t')] if exists else []
        backup=ROOT/'backups'/('palace-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.json')
        backup.parent.mkdir(parents=True,exist_ok=True);backup.write_text(json.dumps(snapshot,ensure_ascii=False,default=str),encoding='utf8')
        c.execute(Path(__file__).with_name('scenic_enrichment.sql').read_text(encoding='utf8'))
        prior=c.execute('SELECT payload_sha256 FROM osm.enrichment_batches WHERE batch_id=%s',(data['batchId'],)).fetchone()
        if prior:
            if prior['payload_sha256']!=payload_hash:raise ValueError('Batch ID already has another payload')
            return dict(status='already_applied',relations=5,facts=9,backup=str(backup))
        found={r['id'] for r in c.execute('SELECT DISTINCT p.id FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id WHERE p.id=ANY(%s)',(ids,))}
        if found!=set(ids):raise ValueError('Place absent from active OSM imports')
        existing={r['child_id']:r['parent_id'] for r in c.execute("SELECT DISTINCT ON(child_id) child_id,parent_id FROM osm.place_relationships WHERE relation_type='part_of' ORDER BY child_id,verified_at DESC")}
        for child,parent in parents.items():
            if child in existing and existing[child]!=parent:raise ValueError('Parent conflict needs review')
        check_graph(existing|parents)
        for row in data['relations']:
            identifier=uuid5(NAMESPACE_URL,json.dumps(row,sort_keys=True,ensure_ascii=False))
            c.execute('INSERT INTO osm.place_relationships(id,child_id,parent_id,relation_type,source_name,source_url,source_timestamp,verified_at,evidence) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
              (identifier,row['childId'],row['parentId'],row['type'],row['sourceName'],row['sourceUrl'],row['sourceTimestamp'],row['verifiedAt'],Jsonb(row['evidence'])))
        for row in data['facts']:
            identifier=uuid5(NAMESPACE_URL,json.dumps(row,sort_keys=True,ensure_ascii=False))
            c.execute('INSERT INTO osm.place_facts(id,place_id,field,value,source_name,source_url,source_timestamp,verified_at,evidence) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
              (identifier,row['placeId'],row['field'],Jsonb(row['value']),row['sourceName'],row['sourceUrl'],row['sourceTimestamp'],row['verifiedAt'],Jsonb(row['evidence'])))
        c.execute('INSERT INTO osm.enrichment_batches(batch_id,payload_sha256,payload) VALUES(%s,%s,%s)',(data['batchId'],payload_hash,Jsonb(data)))
    return dict(status='applied',relations=5,facts=9,backup=str(backup),payloadSha256=payload_hash)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('file',type=Path);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    data=json.loads(args.file.read_text(encoding='utf8'));validate(data)
    print(json.dumps(apply(data) if args.apply else dict(status='validated',relations=5,facts=9),ensure_ascii=False))
