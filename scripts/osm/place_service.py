"""Bounded, loopback-only HTTP gateway for the existing read-only OSM account.

No provider content is written into OSM. No database owner credential is read.
Run on the database host, then use the application backend or an SSH tunnel.
"""
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
import argparse
import json
import math
import re
import sys
import threading
import time
from place_policy import clean_text, country_code, display_name, fact_status, select_fact

ROOT = Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0, str(ROOT / '.deps'))
CATEGORIES = {'attraction','heritage','nature','leisure','accommodation','food','rest','transport','shopping','settlement','service'}
SCENIC = ['attraction','heritage','nature','leisure']
COUNTRIES = {'japan':'JP','south-korea':'KR','thailand':'TH','vietnam':'VN','taiwan':'TW','maldives':'MV'}
SUBTYPES = {'hotel':'酒店','motel':'汽车旅馆','guest_house':'民宿 / 客房','hostel':'青年旅舍','apartment':'公寓','chalet':'度假屋','camp_site':'露营地','caravan_site':'房车营地','alpine_hut':'山间小屋','wilderness_hut':'野外庇护所','shelter':'遮蔽休息处','toilets':'卫生间','drinking_water':'饮水点','bench':'座椅','rest_area':'休息区','services':'服务区'}
NAMED="COALESCE(NULLIF(btrim(p.name),''),NULLIF(btrim(p.tags->>'name'),''),NULLIF(btrim(p.tags->>'name:en'),''),NULLIF(btrim(p.tags->>'brand'),'')) IS NOT NULL"

def editorial_fact(data, now=None):
    now=now or datetime.now(timezone.utc)
    evidence=data.get('evidence') or {}
    status=fact_status(data,now)
    return {'value':None if status=='needs_review' else data['value'],'status':status,
      'source':data['source_name'],'sourceUrl':data['source_url'],'sourceTimestamp':data['source_timestamp'],
      'recordedAt':data['recorded_at'],'verifiedAt':data['verified_at'],'evidence':evidence}

def parse_search(params):
    def value(key, default=None):
        values = params.get(key, [default])
        if len(values) != 1:
            raise ValueError('查询参数不能重复')
        return values[0]
    q = clean_text(str(value('q',''))) or ''
    category, region, subtype = value('category'), value('region'), value('subcategory')
    if len(q)>120 or (category and category not in CATEGORIES | {'scenic'}):
        raise ValueError('名称或分类无效')
    if region and not re.fullmatch(r'[a-z-]{2,50}',region):
        raise ValueError('数据区域无效')
    if subtype and not re.fullmatch(r'[a-z_]{1,50}',subtype):
        raise ValueError('子分类无效')
    limit = int(value('limit',30))
    if not 1<=limit<=60:
        raise ValueError('结果数量须在 1–60 之间')
    lon, lat = value('lng'), value('lat')
    radius = float(value('radius',10000))
    if (lon is None) != (lat is None):
        raise ValueError('经纬度必须同时提供')
    if lon is not None:
        lon,lat = float(lon),float(lat)
        if not all(math.isfinite(x) for x in [lon,lat,radius]) or not (-180<=lon<=180 and -90<=lat<=90 and 1<=radius<=50000):
            raise ValueError('坐标无效，半径须在 1–50000 米之间')
    elif len(q)<2:
        raise ValueError('请输入至少两个字符，或选择附近搜索的中心')
    return {'q':q,'category':category,'region':region,'subcategory':subtype,'limit':limit,'lon':lon,'lat':lat,'radius':radius}

def search_sql(b, alias_ids=None):
    args = {'q':b['q'], 'ids':alias_ids or [], **b}
    filters = ['p.selectable', NAMED]
    if b['category']:
        args['categories'] = SCENIC if b['category']=='scenic' else [b['category']]
        filters.append('p.category=ANY(%(categories)s)')
    if b['region']:
        filters.append('i.region=%(region)s')
    if b['subcategory']:
        filters.append('p.subcategory=%(subcategory)s')
    if b['lon'] is not None:
        filters.append('ST_DWithin(p.location,ST_SetSRID(ST_MakePoint(%(lon)s,%(lat)s),4326)::geography,%(radius)s)')
    condition = None
    if b['q']:
        args['pattern'] = '%' + b['q'].replace('\\','\\\\').replace('%','\\%').replace('_','\\_') + '%'
        condition = 'p.search_text ILIKE %(pattern)s'
        if len(b['q'])==2:
            args['pair'] = [b['q'].lower()]
            condition += ' AND p.name_pairs @> %(pair)s'
    distance = 'NULL::double precision' if b['lon'] is None else 'ST_Distance(p.location,ST_SetSRID(ST_MakePoint(%(lon)s,%(lat)s),4326)::geography)'
    # Retrieve source-name and editorial-alias candidates independently. A broad
    # OR across the text and primary-key predicates scanned millions of rows in
    # acceptance; UNION ALL preserves each branch's existing index access.
    projection = '''SELECT p.id,p.name,p.aliases,p.category,p.subcategory,
      p.lon,p.lat,p.city,p.province,p.country_code,p.opening_hours,p.fee,p.access,p.tags,p.coordinate_role,
      i.region AS extract_region,i.pbf_timestamp AS source_timestamp,i.loaded_at AS source_loaded_at,''' + distance + ''' AS distance_m
      FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id
      JOIN osm.imports i ON i.id=p.import_id WHERE ''' + ' AND '.join(filters)
    branches = [projection + (' AND (' + condition + ')' if condition else '')]
    if condition and args['ids']:
        branches.append(projection + ' AND p.id=ANY(%(ids)s)')
    if not b['q']:
        # GiST KNN reads a bounded nearby pool before expensive projection and
        # deduplication. Final ordering uses ellipsoidal distance within this pool;
        # this is candidate retrieval, not a globally optimal road route.
        args['pool_limit']=max(120,b['limit']*8)
        branches=[projection+' ORDER BY p.location <-> ST_SetSRID(ST_MakePoint(%(lon)s,%(lat)s),4326)::geography LIMIT %(pool_limit)s']
    sql = 'WITH candidates AS MATERIALIZED (' + ' UNION ALL '.join(branches) + '''),
      objects AS (SELECT DISTINCT ON (id) id,name,aliases,category,subcategory,
      lon,lat,city,province,country_code,opening_hours,fee,access,tags,coordinate_role,
      extract_region,source_timestamp,distance_m FROM candidates
      ORDER BY id,source_timestamp DESC NULLS LAST,source_loaded_at DESC)
      SELECT * FROM objects u ORDER BY
      CASE WHEN u.id=ANY(%(ids)s) THEN 0 ELSE osm.name_match_cost(u.name,u.aliases,%(q)s) END,
      CASE WHEN %(q)s='' THEN 0 WHEN category IN ('attraction','heritage','nature','leisure') THEN 0
           WHEN category='settlement' THEN 1 ELSE 2 END,
      distance_m NULLS LAST,name,id LIMIT %(limit)s'''
    return sql,args

def present(row):
    r = dict(row)
    tags = r.pop('tags',{}) or {}
    source_country = r.pop('country_code',None)
    country = country_code(source_country)
    country_source = ('OSM tag' if country==source_country else 'normalized_osm_tag') if country else None
    source_name=r['name']
    r['name']=display_name(source_name,tags)
    r['aliases']=list(dict.fromkeys(x for x in (clean_text(v) for v in r.get('aliases',[])) if x))
    r['city'],r['province']=clean_text(r.get('city')),clean_text(r.get('province'))
    r['normalization']={'ruleVersion':'place-text/1','sourceName':source_name,'sourceCountryCode':source_country,
       'countryStatus':'normalized' if country and country!=source_country else 'source_reported' if country else 'unknown',
       'sourcePreserved':True}
    if not country and r['extract_region'] in COUNTRIES:
        country, country_source = COUNTRIES[r['extract_region']], 'extract_region_hint'
    # China includes Hong Kong/Macao; do not infer mainland routing eligibility.
    r.update(lng=r.pop('lon'),country=country,countrySource=country_source,coord_system='WGS84',
             source='OpenStreetMap',license='ODbL-1.0',source_url='https://www.openstreetmap.org/'+r['id'][4:],
             data_status='reference',verified_at=None)
    r['editorialAliases'] = []
    r['aliasProvenance'] = None
    subtype = tags.get('tourism') if r['category']=='accommodation' else r['subcategory']
    r['subcategoryLabel'] = SUBTYPES.get(subtype,subtype)
    r['travelRoles'] = [r['category']]
    if tags.get('historic') and 'heritage' not in r['travelRoles']:
        r['travelRoles'].append('heritage')
    r['facts'] = {}
    fields = {'openingHours':r['opening_hours'],'fee':r['fee'],'website':tags.get('website') or tags.get('contact:website'),
              'phone':tags.get('phone') or tags.get('contact:phone'),'wheelchair':tags.get('wheelchair'),
              'reservation':tags.get('reservation'),'checkIn':tags.get('check_in'),'checkOut':tags.get('check_out'),
              'address':tags.get('addr:full') or ' '.join(filter(None,[tags.get('addr:street'),tags.get('addr:housenumber')])),
              'access':r.get('access'),'lastEntry':None,'ticketPrice':None,'stayMinutes':None}
    for key,val in fields.items():
        original=val
        if isinstance(val,str):val=clean_text(val)
        # fee is a flag, not a price. Historic numeric tags lack a reliable
        # currency/scope, so retain them as source values without displaying a
        # guessed ticket price or the nonsensical flag "是否收费: 90".
        if key=='fee' and val not in ('yes','no','donation'):val=None
        r['facts'][key] = {'value':val or None,'rawValue':original,'status':'source_reported' if val else 'unknown',
                           'source':'OpenStreetMap' if val else None,'sourceTimestamp':r['source_timestamp'] if val else None,'verifiedAt':None}
    r['missingFields'] = [k for k,v in r['facts'].items() if v['status']=='unknown']
    return r

class Gateway:
    def __init__(self, config):
        self.config = config
        self.slots = threading.BoundedSemaphore(2)

    def execute(self, sql, args=None, timeout_seconds=4):
        import psycopg
        from psycopg.rows import dict_row
        if not self.slots.acquire(timeout=0.5):
            raise ServiceBusy('查询繁忙，请稍后重试')
        try:
            with psycopg.connect(**self.config,connect_timeout=3,row_factory=dict_row) as conn:
                conn.execute("SELECT set_config('statement_timeout',%s,true)",(str(timeout_seconds*1000),))
                conn.execute('SET LOCAL transaction_read_only=on')
                # Radius estimates can be several thousand times too low here,
                # causing bitmap+sort despite LIMIT. Only the bounded KNN query
                # uses this transaction-local plan setting; named searches retain
                # their GIN bitmap plans. No global database setting is changed.
                if isinstance(args,dict) and 'pool_limit' in args:
                    conn.execute('SET LOCAL enable_bitmapscan=off')
                return conn.execute(sql,args).fetchall()
        finally:
            self.slots.release()

    def get(self, path, params):
        started = time.perf_counter()
        if path=='/health':
            self.execute('SELECT 1')
            return {'status':'live','service':'seatraces-osm','readOnly':True,'version':6}
        if path=='/cluster-places':
            from cluster_catalog import cluster_places
            return cluster_places(self,params)
        if path=='/place-batch':
            from cluster_catalog import place_batch
            return place_batch(self,params)
        if path=='/coverage':
            rows = self.execute('SELECT i.region,i.rows_count,i.pbf_timestamp FROM osm.imports i JOIN osm.active_imports a ON a.import_id=i.id ORDER BY i.region')
            return {'status':'live','regions':rows,'rows':sum(r['rows_count'] for r in rows),'countScope':'active import rows; shared OSM IDs may overlap','attribution':'© OpenStreetMap contributors · ODbL-1.0'}
        if path=='/places':
            b = parse_search(params)
            aliases=self.execute('SELECT place_id FROM osm.editorial_aliases WHERE lower(alias)=lower(%s)',(b['q'],)) if b['q'] else []
            rows = self.execute(*search_sql(b,[a['place_id'] for a in aliases]))
            return {'status':'live','scope':'server_osm','items':self.enrich(rows),
                    'elapsedMs':round((time.perf_counter()-started)*1000,2),'limit':b['limit'],
                    'query':b['q'],'attribution':'© OpenStreetMap contributors · ODbL-1.0'}
        if path=='/place':
            ids=params.get('id',[])
            if len(ids)!=1 or not re.fullmatch(r'osm:(node|way|relation)/[0-9]{1,20}',ids[0]):
                raise ValueError('地点 ID 无效')
            rows=self.execute('''SELECT p.id,p.name,p.aliases,p.category,p.subcategory,p.lon,p.lat,p.city,p.province,
              p.country_code,p.opening_hours,p.fee,p.access,p.tags,p.coordinate_role,i.region AS extract_region,i.pbf_timestamp AS source_timestamp
              FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id JOIN osm.imports i ON i.id=p.import_id
              WHERE p.id=%s AND p.selectable AND '''+NAMED+''' ORDER BY i.pbf_timestamp DESC NULLS LAST,i.loaded_at DESC LIMIT 1''',(ids[0],))
            return {'status':'live','item':self.enrich(rows)[0] if rows else None}
        raise LookupError('接口不存在')

    def enrich(self, rows):
        if not rows:return []
        return self.annotate([present(r) for r in rows])

    def annotate(self, items):
        if not items:return []
        ids=[r['id'] for r in items]
        extras=self.execute('''SELECT place_id,'alias' AS kind,to_jsonb(a) AS payload FROM osm.editorial_aliases a WHERE place_id=ANY(%s)
          UNION ALL SELECT place_id,'fact' AS kind,to_jsonb(f) AS payload FROM
          (SELECT * FROM osm.place_facts WHERE place_id=ANY(%s)) f''',(ids,ids))
        by_id={r['id']:r for r in items}
        for p in by_id.values():
            p.setdefault('facts',{});p.setdefault('editorialAliases',[])
        versions={}
        for entry in extras:
            p=by_id[entry['place_id']];data=entry['payload']
            if entry['kind']=='alias':
                p['editorialAliases'].append(data['alias'])
                p['aliasProvenance']='SeaTraces 编辑补充；原始 OSM 名称保留，补充记录可追溯'
                p.setdefault('aliasSources',[]).append(data)
            else:
                versions.setdefault((entry['place_id'],data['field']),[]).append(data)
        for (place_id,field),records in versions.items():
            by_id[place_id]['facts'][field]=editorial_fact(select_fact(records))
        relations=self.execute('''SELECT * FROM (
          SELECT DISTINCT ON(child_id,relation_type) * FROM osm.place_relationships
          ORDER BY child_id,relation_type,verified_at DESC,recorded_at DESC,id
          ) r WHERE child_id=ANY(%s) OR parent_id=ANY(%s)''',(ids,ids))
        for r in relations:
            status=fact_status(r)
            if r['child_id'] in by_id:
                p=by_id[r['child_id']]
                edge={'parentId':r['parent_id'],'type':r['relation_type'],'status':status,
                  'sourceUrl':r['source_url'],'verifiedAt':r['verified_at'],'evidence':r['evidence']}
                p.setdefault('relationships',[]).append(edge)
                if r['relation_type']=='part_of' and status=='evidence_reviewed':
                    p['parentId']=r['parent_id'];p['parentRelation']=edge
            if r['parent_id'] in by_id and r['relation_type']=='part_of' and status=='evidence_reviewed':
                by_id[r['parent_id']].setdefault('childPlaceIds',[]).append(r['child_id'])
        for p in by_id.values():p['missingFields']=[k for k,v in p['facts'].items() if v['value'] is None]
        return list(by_id.values())

class ServiceBusy(Exception):pass

def handler(gateway):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            try:
                if len(self.path)>2000:
                    raise ValueError('查询过长')
                u=urlsplit(self.path)
                value=gateway.get(u.path,parse_qs(u.query,keep_blank_values=True,max_num_fields=15))
                self.reply(200,value)
            except ValueError as e:
                self.reply(400,{'error':str(e)})
            except LookupError as e:
                self.reply(404,{'error':str(e)})
            except ServiceBusy:
                self.reply(429,{'error':'地点查询繁忙，请稍后重试','code':'catalog_busy'})
            except Exception as e:
                code='catalog_query_timeout' if getattr(e,'sqlstate',None)=='57014' else 'catalog_unavailable'
                # No SQL, query names, coordinates, configuration or secrets in logs.
                print(json.dumps({'event':'catalog_error','code':code,'type':type(e).__name__}),file=sys.stderr,flush=True)
                self.reply(504 if code=='catalog_query_timeout' else 503,{'error':'地点查询超时，请缩小范围重试' if code=='catalog_query_timeout' else '地点服务暂时不可用','code':code})
        def reply(self,status,value):
            data=json.dumps(value,ensure_ascii=False,default=str,allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(data)))
            self.send_header('Cache-Control','no-store')
            self.end_headers()
            self.wfile.write(data)
        def log_message(self,*args):
            pass  # No locations, names or credentials in routine access logs.
    return Handler

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,default=ROOT/'reader.json')
    parser.add_argument('--port',type=int,default=8791)
    args=parser.parse_args()
    service=Gateway(json.loads(args.config.read_text()))
    service.get('/health',{})
    print('OSM read gateway listening on 127.0.0.1:'+str(args.port),flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),handler(service)).serve_forever()
