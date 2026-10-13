"""Bounded bulk read for city clustering, separate from interactive POI lookup."""
import math,time
import re

def place_batch(gateway,params):
    values=params.get('ids',[])
    ids=values[0].split(',') if len(values)==1 else []
    if not 1<=len(ids)<=40 or not all(re.fullmatch(r'osm:(node|way|relation)/[0-9]{1,20}',i) for i in ids):raise ValueError('地点批量参数无效')
    rows=gateway.execute('''SELECT DISTINCT ON (p.id) p.id,p.name,p.aliases,p.category,p.subcategory,p.lon,p.lat,p.city,p.province,
      p.country_code,p.opening_hours,p.fee,p.access,p.tags,p.coordinate_role,i.region AS extract_region,i.pbf_timestamp AS source_timestamp
      FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id JOIN osm.imports i ON i.id=p.import_id
      WHERE p.id=ANY(%s) AND p.selectable ORDER BY p.id,i.pbf_timestamp DESC NULLS LAST,i.loaded_at DESC''',(ids,))
    return {'status':'live','items':gateway.enrich(rows)}

def cluster_places(gateway,params):
    from place_service import NAMED,SCENIC
    from place_policy import clean_text,country_code,display_name
    def number(k):
        v=params.get(k,[])
        if len(v)!=1:raise ValueError('城市范围参数无效')
        n=float(v[0])
        if not math.isfinite(n):raise ValueError('城市范围参数无效')
        return n
    w,s,e,n=[number(k) for k in ('west','south','east','north')]
    if not(-180<=w<e<=180 and -85<=s<n<=85 and e-w<=8 and n-s<=8):raise ValueError('城市范围过大或无效')
    sql='''SELECT DISTINCT ON (p.id) p.id,p.name,p.aliases,p.category,p.subcategory,p.lon,p.lat,
        p.city,p.province,p.country_code,p.opening_hours,p.access,p.coordinate_role,
        jsonb_strip_nulls(jsonb_build_object('name',p.tags->'name','name:en',p.tags->'name:en',
          'tourism',p.tags->'tourism','historic',p.tags->'historic','leisure',p.tags->'leisure',
          'natural',p.tags->'natural','wikidata',p.tags->'wikidata','wikipedia',p.tags->'wikipedia',
          'heritage',p.tags->'heritage','website',p.tags->'website')) AS traits,
        i.region,i.pbf_timestamp AS source_timestamp
        FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id JOIN osm.imports i ON i.id=p.import_id
        WHERE p.selectable AND p.category=ANY(%(categories)s) AND '''+NAMED+'''
        AND p.location && ST_MakeEnvelope(%(west)s,%(south)s,%(east)s,%(north)s,4326)::geography
        AND p.lon BETWEEN %(west)s AND %(east)s AND p.lat BETWEEN %(south)s AND %(north)s
        ORDER BY p.id,i.pbf_timestamp DESC NULLS LAST,i.loaded_at DESC LIMIT 8001'''
    started=time.perf_counter()
    rows=gateway.execute(sql,dict(west=w,south=s,east=e,north=n,categories=SCENIC),timeout_seconds=12)
    limited=len(rows)>8000
    items=[]
    for r in rows[:8000]:
        tags=r.pop('traits') or {};raw_name=r['name'];r['name']=display_name(raw_name,tags)
        r['country']=country_code(r.pop('country_code'));r['lng']=r.pop('lon')
        r['traits']=tags;r['coord_system']='WGS84';r['source']='OpenStreetMap';r['license']='ODbL-1.0'
        items.append(r)
    items=gateway.annotate(items)
    return {'status':'live','items':items,'coverageStatus':'bounded_sample' if limited else 'within_requested_bbox',
      'bounds':[w,s,e,n],'elapsedMs':round((time.perf_counter()-started)*1000,2),'attribution':'© OpenStreetMap contributors · ODbL-1.0'}
