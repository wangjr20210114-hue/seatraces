import unittest
from entity_identity import evidence,group_matches,aliases_for,identity_keys,normalize
from entity_catalog import merge_records,canonical_search_sql
from place_service import parse_search,search_sql


def obj(oid,name,aliases=None,**kw):
    return dict(id=oid,name=name,aliases=aliases or [],category='attraction',tags={},dimension=0,area_m2=0,**kw)


class IdentityTests(unittest.TestCase):
    def test_point_area_requires_identity_and_full_coverage(self):
        park=obj('a','示例公园',['Sample Park']);marker=obj('b','Sample Park')
        self.assertIsNotNone(evidence(park,marker,dict(kind='point_area',covered=True)))
        self.assertIsNone(evidence(park,marker,dict(kind='point_area',covered=False)))
        self.assertIsNone(evidence(park,obj('c','太和殿'),dict(kind='point_area',covered=True)))
        self.assertIsNone(evidence(obj('a','公园'),obj('b','公园'),dict(kind='point_area',covered=True)))

    def test_branches_and_conflicting_identities_not_merged(self):
        a=obj('a','示例博物馆东馆',['示例博物馆']);b=obj('b','示例博物馆西馆',['示例博物馆'])
        self.assertIsNone(evidence(a,b,dict(kind='point_area',covered=True)))
        a=obj('a','故宫');b=obj('b','故宫');a['tags']={'wikidata':'Q1'};b['tags']={'wikidata':'Q2'}
        self.assertIsNone(evidence(a,b,dict(kind='point_area',covered=True)))

    def test_near_points_and_nested_areas_are_not_sufficient(self):
        a=obj('a','同名亭');b=obj('b','同名亭')
        self.assertIsNone(evidence(a,b,dict(kind='point_point',distance=1)))
        a['tags']=b['tags']={'wikidata':'Q123'}
        self.assertIsNotNone(evidence(a,b,dict(kind='point_point',distance=1)))
        self.assertIsNone(evidence(a,b,dict(kind='point_point',distance=20)))
        self.assertIsNone(evidence(a,b,dict(kind='area_area',overlap=.3)))
        self.assertIsNotNone(evidence(a,b,dict(kind='area_area',overlap=.99)))

    def test_no_transitive_bridging(self):
        records={i:obj(i,'同名景区') for i in 'abc'}
        result=group_matches(records,[('a','b',{'rule':'same'}),('b','c',{'rule':'same'})])
        self.assertEqual([(m,[i for i,_ in members]) for m,members in result],[('a',['a','b'])])

    def test_polygon_canonical_and_search_aliases(self):
        a=obj('osm:relation/1','故宫');a.update(dimension=2,area_m2=100)
        b=obj('osm:node/2','故宫博物院',['Palace Museum','1','故宫'])
        groups=group_matches({a['id']:a,b['id']:b},[(a['id'],b['id'],{'reviewed':True})])
        self.assertEqual(groups[0][0],a['id'])
        self.assertEqual([x[0] for x in aliases_for([a,b],a)],['故宫博物院','Palace Museum'])
        self.assertEqual(normalize(' ＡＢＣ  park '),'abcpark')
        self.assertIn('n:palacemuseum',identity_keys(b))

    def test_merge_preserves_evidence_and_prefers_current_reviewed_fact(self):
        a=obj('area','故宫');b=obj('point','故宫博物院',['Palace Museum'])
        a['facts']={'openingHours':dict(value='old',status='source_reported',sourceTimestamp='2020')}
        b['facts']={'openingHours':dict(value='new',status='evidence_reviewed',verifiedAt='2026',evidence={'url':'official'}),
                    'website':dict(value='https://www.dpm.org.cn',status='source_reported')}
        merged=merge_records(a,[a,b],{'build_id':'b'},[{'reviewed':True}])
        self.assertEqual(merged['name'],'故宫')
        self.assertEqual(merged['aliases'],['故宫博物院','Palace Museum'])
        self.assertEqual(merged['facts']['openingHours']['value'],'new')
        self.assertEqual(merged['facts']['openingHours']['sourcePlaceId'],'point')
        self.assertEqual(merged['factAlternatives']['openingHours'][0]['value'],'old')
        self.assertEqual(merged['possibleDuplicateIds'],['point'])
        self.assertEqual(a['facts']['openingHours']['value'],'old')

    def test_search_groups_before_limit_for_alias_and_nearby_queries(self):
        for params in [{'q':['故宫博物院']},{'q':['故宫']},{'lng':['116.39'],'lat':['39.91']}]:
            sql,args=search_sql(parse_search(params),['osm:node/2'])
            result,bound=canonical_search_sql(sql,args,{'build_id':'dedup'})
            self.assertIn('PARTITION BY COALESCE(m.canonical_id,u.id)',result)
            self.assertIn('WHERE entity_rank=1 ORDER BY',result)
            self.assertTrue(result.endswith('LIMIT %(limit)s'))
            self.assertEqual(bound['entity_build'],'dedup')
        with self.assertRaises(ValueError):canonical_search_sql('SELECT 1',{}, {'build_id':'b'})


if __name__=='__main__':unittest.main()
