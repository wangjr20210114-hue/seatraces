"""Read-only geometric parent/children API. Pin one immutable build per request."""
from site_catalog import ID, CATEGORIES

METHOD='full_geometry_covers_smallest_scenic_area'


def active_build(gateway):
    rows=gateway.execute('SELECT build_id FROM osm.containment_active')
    return rows[0]['build_id'] if rows else None


def annotate_containment(gateway,items,build=None):
    if not items:return items
    build=build or active_build(gateway)
    if not build:return items
    rows=gateway.execute('''SELECT p.id,p.geometry_state,e.parent_id,e.natural_parent_id,e.root_id,
       e.depth,e.natural_depth,e.depth_limited,s.child_count,s.children_by_category
       FROM osm.containment_places p
       LEFT JOIN osm.containment_edges e ON e.build_id=p.build_id AND e.child_id=p.id
       LEFT JOIN osm.containment_summary s ON s.build_id=p.build_id AND s.id=p.id
       WHERE p.build_id=%s AND p.id=ANY(%s)''',(build,[p['id'] for p in items]))
    indexed={r['id']:r for r in rows}
    for p in items:
        row=indexed.get(p['id'])
        if not row:continue
        child=bool(row['parent_id'])
        status='child' if child else 'geometry_unavailable' if row['geometry_state']=='unavailable_geometry' else 'no_enclosing_scenic_boundary'
        hierarchy=dict(buildId=build,parentId=row['parent_id'],naturalParentId=row['natural_parent_id'],
           rootId=row['root_id'] or p['id'],depth=row['depth'] or 1,naturalDepth=row['natural_depth'] or 1,
           depthLimited=bool(row['depth_limited']),maxDepth=8,rootLevel=1,
           childCount=row['child_count'] or 0,childrenByCategory=row['children_by_category'] or {},
           geometryState=row['geometry_state'],status=status,method=METHOD,categoryPreserved=True)
        # Keep source evidence in relationships/siteHierarchy, publish this product rule as parentId.
        p['geometricHierarchy']=hierarchy
        if 'childPlaceIds' in p:
            p['editorialChildPlaceIds']=p.pop('childPlaceIds')
        p['parentId']=row['parent_id']
        p['hierarchyLevel']=hierarchy['depth']
        p['parentLookup']={'status':'child' if child else 'unknown' if status=='geometry_unavailable' else 'root',
                           'provider':'osm_geometry','buildId':build}
        p['parentRelation']={'type':'located_in' if child else None,'status':'rule_derived' if child else 'not_assigned','method':METHOD,'provider':'osm_geometry',
                              'buildId':build,'geometryState':row['geometry_state']}
    return items


def containment_get(gateway,path,params):
    if path=='/hierarchy-coverage':
        rows=gateway.execute('''SELECT b.build_id,b.algorithm,b.completed_at,b.summary
           FROM osm.containment_builds b JOIN osm.containment_active a USING(build_id)''')
        return {'status':'live','build':rows[0] if rows else None,'attribution':'© OpenStreetMap contributors · ODbL-1.0'}
    def value(key,default=None):
        values=params.get(key,[default])
        if len(values)!=1:raise ValueError('重复参数')
        return values[0]
    place_id=value('id','');after=value('after','');category=value('category');limit=int(value('limit',50))
    if not ID.fullmatch(place_id) or (after and not ID.fullmatch(after)) or not 1<=limit<=200:
        raise ValueError('层级查询参数无效')
    if category and category not in CATEGORIES:raise ValueError('分类无效')
    build=active_build(gateway)
    empty={'status':'live','buildId':build,'item':None,'ancestors':[],'children':[],'nextCursor':None}
    if not build:return empty
    columns='p.id,p.name,p.category,p.subcategory,p.lon AS lng,p.lat,p.source_region,p.source_timestamp'
    rows=gateway.execute('SELECT '+columns+' FROM osm.containment_places p WHERE p.build_id=%s AND p.id=%s',(build,place_id))
    if not rows:return empty
    item=annotate_containment(gateway,rows,build)[0]
    ancestors=gateway.execute('''WITH RECURSIVE chain AS (
      SELECT e.parent_id,1 AS distance FROM osm.containment_edges e WHERE e.build_id=%s AND e.child_id=%s
      UNION ALL SELECT e.parent_id,c.distance+1 FROM chain c JOIN osm.containment_edges e
      ON e.child_id=c.parent_id AND e.build_id=%s WHERE c.distance<7)
      SELECT '''+columns+''',c.distance FROM chain c JOIN osm.containment_places p
      ON p.id=c.parent_id AND p.build_id=%s ORDER BY c.distance DESC''',(build,place_id,build,build))
    children=gateway.execute('SELECT '+columns+''' FROM osm.containment_edges e JOIN osm.containment_places p
      ON p.build_id=e.build_id AND p.id=e.child_id WHERE e.build_id=%s AND e.parent_id=%s AND e.child_id>%s
      AND (%s::text IS NULL OR p.category=%s) ORDER BY e.child_id LIMIT %s''',(build,place_id,after,category,category,limit+1))
    cursor=children[limit-1]['id'] if len(children)>limit else None
    return dict(status='live',buildId=build,item=item,ancestors=annotate_containment(gateway,ancestors,build),
                children=annotate_containment(gateway,children[:limit],build),nextCursor=cursor,
                relationType='located_in',relationStatus='rule_derived',maxDepth=8,
                attribution='© OpenStreetMap contributors · ODbL-1.0')
