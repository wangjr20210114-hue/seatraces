"""Canonical scenic read model; source records remain independently auditable."""
from contextvars import ContextVar
from copy import deepcopy
import sys
import time
from entity_identity import normalize
from site_catalog import ID, CATEGORIES

CONTEXT=ContextVar('entity_read_version', default=None)
ATTRIBUTION='© OpenStreetMap contributors · ODbL-1.0'


def current(gateway):
    rows=gateway.execute('''SELECT b.build_id,b.containment_build,b.completed_at,b.summary FROM osm.entity_active a
        JOIN osm.entity_builds b USING(build_id) JOIN osm.containment_active c ON c.build_id=b.containment_build
        WHERE b.status='complete' ''')
    return rows[0] if rows else None


def resolve(gateway, ids, build):
    rows=gateway.execute('SELECT source_id,canonical_id FROM osm.entity_members WHERE build_id=%s AND source_id=ANY(%s)',(build['build_id'],ids))
    index={r['source_id']:r['canonical_id'] for r in rows}
    return [index.get(i,i) for i in ids]


def canonical_search_sql(sql,args,build):
    marker='SELECT * FROM objects u ORDER BY'
    if sql.count(marker)!=1: raise ValueError('Search SQL shape changed; identity adapter requires review')
    prefix=sql.split(marker)[0]
    order="""CASE WHEN u.id=ANY(%(ids)s) THEN 0 ELSE osm.name_match_cost(u.name,u.aliases,%(q)s) END,
        CASE WHEN %(q)s='' THEN 0 WHEN category IN ('attraction','heritage','nature','leisure') THEN 0
             WHEN category='settlement' THEN 1 ELSE 2 END,distance_m NULLS LAST,name,id"""
    # Deduplicate before LIMIT, not after fetching a small candidate sample.
    return prefix+''', numbered AS (SELECT u.*,ROW_NUMBER() OVER (
        PARTITION BY COALESCE(m.canonical_id,u.id) ORDER BY '''+order+''') AS entity_rank
        FROM objects u LEFT JOIN osm.entity_members m ON m.build_id=%(entity_build)s AND m.source_id=u.id)
        SELECT * FROM numbered u WHERE entity_rank=1 ORDER BY '''+order+' LIMIT %(limit)s',dict(args,entity_build=build['build_id'])


def fact_rank(fact):
    tiers={'evidence_reviewed':5,'verified':5,'source_reported':3,'needs_review':0,'unknown':0}
    return (fact.get('value') is not None,tiers.get(fact.get('status'),1),
            str(fact.get('verifiedAt') or fact.get('sourceTimestamp') or ''))


def merge_records(main, records, build, evidence):
    result=deepcopy(main)
    seen={normalize(result['name'])}; aliases=[]
    for p in records:
        for value in [p['name'],*(p.get('aliases') or []),*(p.get('editorialAliases') or [])]:
            key=normalize(value)
            if key and not key.isnumeric() and key not in seen:
                aliases.append(value);seen.add(key)
        for field,fact in (p.get('facts') or {}).items():
            old=result.setdefault('facts',{}).get(field)
            if old is None or fact_rank(fact)>fact_rank(old):
                if old and old.get('value') is not None and old.get('value')!=fact.get('value'):
                    result.setdefault('factAlternatives',{}).setdefault(field,[]).append(dict(old))
                result['facts'][field]=dict(fact,sourcePlaceId=p['id'])
            elif old.get('value') is not None and fact.get('value') is not None and old['value']!=fact['value']:
                result.setdefault('factAlternatives',{}).setdefault(field,[]).append(dict(fact,sourcePlaceId=p['id']))
    result['aliases']=aliases
    source_ids=sorted({p['id'] for p in records})
    result['possibleDuplicateIds']=[i for i in source_ids if i!=main['id']]
    result['sourceRecords']=[{k:p.get(k) for k in ('id','name','category','subcategory','source_url')} for p in records]
    result['entityIdentity']=dict(buildId=build['build_id'],canonicalId=main['id'],sourceIds=source_ids,
        status='canonical',method='identity_and_geometry',evidence=evidence)
    result['missingFields']=[k for k,v in result.get('facts',{}).items() if v.get('value') is None]
    # Legacy convenience fields follow the selected fact, never an invented inheritance.
    for raw,field in [('opening_hours','openingHours'),('fee','fee'),('access','access')]:
        if field in result.get('facts',{}): result[raw]=result['facts'][field]['value']
    return result


def source_rows(gateway, ids):
    if not ids:return []
    return gateway.execute('''SELECT DISTINCT ON(p.id) p.id,p.name,p.aliases,p.category,p.subcategory,p.lon,p.lat,
        p.city,p.province,p.country_code,p.opening_hours,p.fee,p.access,p.tags,p.coordinate_role,
        i.region AS extract_region,i.pbf_timestamp AS source_timestamp FROM osm.poi p
        JOIN osm.active_imports a ON a.import_id=p.import_id JOIN osm.imports i ON i.id=p.import_id
        WHERE p.id=ANY(%s) AND p.selectable ORDER BY p.id,i.pbf_timestamp DESC NULLS LAST,i.loaded_at DESC''',(ids,))


def annotate(gateway,items,build,original,module):
    if not items:return []
    ids=[p['id'] for p in items]
    canonical=resolve(gateway,ids,build)
    targets=list(dict.fromkeys(canonical))
    membership=gateway.execute('SELECT source_id,canonical_id,evidence FROM osm.entity_members WHERE build_id=%s AND canonical_id=ANY(%s)',(build['build_id'],targets))
    needed={m['source_id'] for m in membership}-set(ids)
    extra=[]
    for row in source_rows(gateway,list(needed)):
        tags=dict(row.get('tags') or {})
        obj=module.present(row);obj['traits']=tags;extra.append(obj)
    enriched={p['id']:p for p in original(gateway,list({p['id']:p for p in [*items,*extra]}.values()))}
    groups={};proof={}
    for m in membership:
        groups.setdefault(m['canonical_id'],[]).append(m['source_id'])
        if m['source_id']!=m['canonical_id']:proof.setdefault(m['canonical_id'],[]).append(m['evidence'])
    output=[]
    for oid in targets:
        if oid not in enriched:raise ValueError('Canonical source object is missing')
        members=groups.get(oid,[oid])
        obj=merge_records(enriched[oid],[enriched[m] for m in members],build,proof.get(oid,[]))
        # Unmerged objects are also marked authoritative so old client heuristics
        # cannot combine separate canonical IDs again.
        output.append(obj)
    hierarchy=gateway.execute('''SELECT p.id,p.geometry_state,e.parent_id,e.root_id,e.depth,s.child_count,s.children_by_category
        FROM osm.containment_places p LEFT JOIN osm.entity_edges e ON e.build_id=%s AND e.child_id=p.id
        LEFT JOIN osm.entity_summary s ON s.build_id=%s AND s.id=p.id WHERE p.build_id=%s AND p.id=ANY(%s)''',
        (build['build_id'],build['build_id'],build['containment_build'],targets))
    indexed={r['id']:r for r in hierarchy}
    for p in output:
        r=indexed.get(p['id'])
        if not r:continue
        h=p.setdefault('geometricHierarchy',{})
        if 'naturalParentId' in h:h['sourceNaturalParentId']=h['naturalParentId']
        h.update(buildId=build['containment_build'],entityBuildId=build['build_id'],parentId=r['parent_id'],
                 naturalParentId=r['parent_id'],rootId=r['root_id'] or p['id'],depth=r['depth'] or 1,
                 naturalDepth=r['depth'] or 1,depthLimited=False,maxDepth=8,rootLevel=1,
                 childCount=r['child_count'] or 0,childrenByCategory=r['children_by_category'] or {},
                 geometryState=r['geometry_state'],status='child' if r['parent_id'] else 'geometry_unavailable' if r['geometry_state']=='unavailable_geometry' else 'no_enclosing_scenic_boundary',
                 method='full_geometry_covers_smallest_scenic_area',categoryPreserved=True)
        p.update(parentId=r['parent_id'],hierarchyLevel=h['depth'])
        p['parentLookup']=dict(status='child' if r['parent_id'] else 'unknown' if r['geometry_state']=='unavailable_geometry' else 'root',provider='osm_geometry',buildId=build['containment_build'])
        p['parentRelation']=dict(type='located_in' if r['parent_id'] else None,status='rule_derived' if r['parent_id'] else 'not_assigned',
                                 provider='osm_geometry',buildId=build['containment_build'],entityBuildId=build['build_id'])
    return output


def hierarchy(gateway,params,build):
    def value(k,default=None):
        v=params.get(k,[default])
        if len(v)!=1:raise ValueError('重复参数')
        return v[0]
    requested=value('id','');after=value('after','');category=value('category');limit=int(value('limit',50))
    if not ID.fullmatch(requested) or (after and not ID.fullmatch(after)) or not 1<=limit<=200 or (category and category not in CATEGORIES):
        raise ValueError('层级查询参数无效')
    oid=resolve(gateway,[requested],build)[0]
    rows=source_rows(gateway,[oid])
    base=dict(status='live',buildId=build['containment_build'],entityBuildId=build['build_id'],requestedId=requested,
              item=None,ancestors=[],children=[],nextCursor=None,maxDepth=8,attribution=ATTRIBUTION)
    if not rows:return base
    base['item']=gateway.enrich(rows)[0]
    ancestors=gateway.execute('''WITH RECURSIVE chain AS (
        SELECT parent_id,1 AS distance FROM osm.entity_edges WHERE build_id=%s AND child_id=%s
        UNION ALL SELECT e.parent_id,c.distance+1 FROM chain c JOIN osm.entity_edges e
        ON e.build_id=%s AND e.child_id=c.parent_id WHERE c.distance<7)
        SELECT parent_id FROM chain ORDER BY distance DESC''',(build['build_id'],oid,build['build_id']))
    parentids=[r['parent_id'] for r in ancestors]
    if parentids:
        found={p['id']:p for p in gateway.enrich(source_rows(gateway,parentids))}
        base['ancestors']=[found[i] for i in parentids]
    children=gateway.execute('''SELECT e.child_id FROM osm.entity_edges e JOIN osm.containment_places p
        ON p.build_id=%s AND p.id=e.child_id WHERE e.build_id=%s AND e.parent_id=%s AND e.child_id>%s
        AND (%s::text IS NULL OR p.category=%s) ORDER BY e.child_id LIMIT %s''',
        (build['containment_build'],build['build_id'],oid,after,category,category,limit+1))
    childids=[r['child_id'] for r in children[:limit]]
    if childids:
        found={p['id']:p for p in gateway.enrich(source_rows(gateway,childids))}
        base['children']=[found[i] for i in childids]
    if len(children)>limit:base['nextCursor']=childids[-1]
    base.update(relationType='located_in',relationStatus='rule_derived')
    return base


def install_entity_gateway(cls):
    if getattr(cls,'_entity_installed',False):return
    module=sys.modules[cls.__module__]
    original_get,original_annotate=cls.get,cls.annotate
    def new_annotate(self,items):
        build=CONTEXT.get()
        return annotate(self,items,build,original_annotate,module) if build else original_annotate(self,items)
    def new_get(self,path,params):
        # Source site membership remains a separate provenance API, not the
        # product hierarchy. Health/coverage do not depend on this overlay.
        if path not in ('/entity-coverage','/places','/place','/place-batch','/cluster-places','/hierarchy'):
            return original_get(self,path,params)
        build=current(self)
        if path=='/entity-coverage':return dict(status='live',build=build,attribution=ATTRIBUTION)
        if not build:return original_get(self,path,params)
        token=CONTEXT.set(build)
        try:
            if path=='/hierarchy':return hierarchy(self,params,build)
            if path=='/places':
                started=time.perf_counter();b=module.parse_search(params)
                aliases=self.execute('''SELECT place_id FROM osm.editorial_aliases WHERE lower(alias)=lower(%s)
                    UNION SELECT source_id FROM osm.entity_aliases WHERE build_id=%s AND normalized=%s''',
                    (b['q'],build['build_id'],normalize(b['q']))) if b['q'] else []
                sql,args=module.search_sql(b,[a['place_id'] for a in aliases])
                rows=self.execute(*canonical_search_sql(sql,args,build))
                for row in rows:row.pop('entity_rank',None)
                return dict(status='live',scope='server_osm',items=self.enrich(rows),limit=b['limit'],query=b['q'],
                    entityBuildId=build['build_id'],elapsedMs=round((time.perf_counter()-started)*1000,2),attribution=ATTRIBUTION)
            if path=='/place':
                requested=params.get('id',[])
                if len(requested)!=1 or not ID.fullmatch(requested[0]):raise ValueError('地点 ID 无效')
                result=original_get(self,path,dict(params,id=resolve(self,requested,build)))
                result['requestedId']=requested[0]
                return result
            return original_get(self,path,params)
        finally:CONTEXT.reset(token)
    cls.get,cls.annotate=new_get,new_annotate
    cls._entity_installed=True
