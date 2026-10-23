"""查询当前 OSM site 层级和成员地点。"""
import re

ID = re.compile(r'osm:(node|way|relation)/[0-9]{1,20}')
CATEGORIES = {'attraction','heritage','nature','leisure','accommodation','food',
              'rest','transport','shopping','settlement','service'}


def annotate_sites(gateway, items):
    if not items:
        return items
    rows=gateway.execute('''SELECT id,parent_ids,child_count,children_by_category,membership_status
        FROM osm.current_site_summary WHERE id=ANY(%s)''',([p['id'] for p in items],))
    summaries={r['id']:r for r in rows}
    for p in items:
        s=summaries.get(p['id'])
        parents=s['parent_ids'] if s else []
        p['siteHierarchy']={
            'parentId':parents[0] if len(parents)==1 else None,'parentIds':parents,
            'childCount':s['child_count'] if s else 0,
            'childrenByCategory':s['children_by_category'] if s else {},
            'status':s['membership_status'] if s else 'no_site_membership_recorded',
            'source':'OpenStreetMap','method':'explicit_site_membership',
            'categoryPreserved':True}
    return items


def present_object(row):
    r=dict(row)
    return {'id':r['id'],'name':r['name'],'category':r['category'],'subcategory':r['subcategory'],
            'isSite':r['is_site'],'catalogPresent':r['catalog_present'],
            'availability':r['availability'],'lng':r['lon'],'lat':r['lat'],
            'coord_system':'WGS84','source':'OpenStreetMap',
            'sourceUrl':'https://www.openstreetmap.org/'+r['id'][4:],
            'sourceTimestamp':r['source_timestamp'],'sourceVersion':r['source_version'],
            'memberRoles':r.get('roles',[]),'buildId':r['build_id']}


def site_get(gateway, path, params):
    if path=='/site-coverage':
        rows=gateway.execute('''SELECT b.build_id,b.algorithm,b.completed_at,b.summary
            FROM osm.site_builds b JOIN osm.site_active a USING(build_id)''')
        return {'status':'live','build':rows[0] if rows else None,
                'attribution':'© OpenStreetMap contributors · ODbL-1.0'}
    def value(key,default=None):
        values=params.get(key,[default])
        if len(values)!=1:raise ValueError('重复参数')
        return values[0]
    place_id=value('id','')
    after=value('after','')
    category=value('category')
    limit=int(value('limit',50))
    if not ID.fullmatch(place_id) or (after and not ID.fullmatch(after)) or not 1<=limit<=200:
        raise ValueError('site 参数无效')
    if category and category not in CATEGORIES:raise ValueError('分类无效')
    rows=gateway.execute('SELECT build_id FROM osm.site_active')
    if not rows:return {'status':'live','item':None,'parents':[],'children':[],'nextCursor':None}
    build=rows[0]['build_id']
    rows=gateway.execute('SELECT * FROM osm.site_objects WHERE build_id=%s AND id=%s',(build,place_id))
    if not rows:return {'status':'live','item':None,'parents':[],'children':[],'nextCursor':None,'buildId':build}
    parents=gateway.execute('''SELECT o.*,e.roles FROM osm.site_edges e JOIN osm.site_objects o
        ON o.build_id=e.build_id AND o.id=e.parent_id WHERE e.build_id=%s
        AND e.child_id=%s AND e.status='source_reported' ORDER BY o.id''',(build,place_id))
    children=gateway.execute('''SELECT o.*,e.roles FROM osm.site_edges e JOIN osm.site_objects o
        ON o.build_id=e.build_id AND o.id=e.child_id WHERE e.build_id=%s
        AND e.parent_id=%s AND e.status='source_reported' AND o.id>%s
        AND (%s::text IS NULL OR o.category=%s) ORDER BY o.id LIMIT %s''',
        (build,place_id,after,category,category,limit+1))
    summary=gateway.execute('SELECT parent_ids,child_count,children_by_category,membership_status FROM osm.site_object_summary WHERE build_id=%s AND id=%s',(build,place_id))
    return {'status':'live','buildId':build,'item':present_object(rows[0]),
            'parents':[present_object(p) for p in parents],
            'children':[present_object(c) for c in children[:limit]],
            'nextCursor':children[limit-1]['id'] if len(children)>limit else None,
            'summary':summary[0] if summary else None,
            'relationType':'site_member','relationStatus':'source_reported',
            'attribution':'© OpenStreetMap contributors · ODbL-1.0'}
