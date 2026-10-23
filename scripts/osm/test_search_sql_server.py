"""验证地点检索 SQL。"""
import json
import unittest
from pathlib import Path
from place_service import Gateway, parse_search, search_sql

ROWS = [
    ('osm:node/1', '東京鐵塔', 'attraction', 'tower', 139.7454, 35.6586, True, 1),
    ('osm:node/2', '东京塔', 'attraction', 'tower', 121.49, 31.24, True, 2),
    ('osm:node/2', '东京塔', 'attraction', 'tower', 121.49, 31.24, True, 3),
    ('osm:node/3', '东京塔旅舍', 'accommodation', 'hostel', 121.5, 25.0, True, 3),
    ('osm:node/4', '东京塔纪念店', 'shopping', 'gift', 139.746, 35.659, True, 1),
    ('osm:node/5', '东京塔', 'attraction', 'tower', 139.7454, 35.6586, False, 1),
    ('osm:node/6', '长城', 'heritage', 'castle', 116.0, 40.0, True, 2),
    ('osm:node/7', '塔楼公园', 'nature', 'park', 121.49, 31.24, True, 2),
]
FIXTURES = json.dumps([dict(zip(
    ['id','name','category','subcategory','lon','lat','selectable','import_id'], row
)) for row in ROWS], ensure_ascii=False)
PREFIX = '''WITH fixture_poi AS (
 SELECT f.*, ARRAY[]::text[] AS aliases,NULL::text AS city,NULL::text AS province,
 NULL::text AS country_code,NULL::text AS opening_hours,NULL::text AS fee,NULL::text AS access,
 '{}'::jsonb AS tags,'source_point'::text AS coordinate_role,name AS search_text,
 osm.search_pairs(name) AS name_pairs,
 ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography AS location
 FROM jsonb_to_recordset(%(fixtures)s::jsonb) AS f(
 id text,name text,category text,subcategory text,lon double precision,lat double precision,
 selectable boolean,import_id integer)),
 fixture_imports(id,region,pbf_timestamp,loaded_at) AS (
 VALUES (1,'japan','2026-10-09'::timestamptz,'2026-10-10'::timestamptz),
 (2,'china','2026-10-09'::timestamptz,'2026-10-10'::timestamptz),
 (3,'taiwan','2026-10-10'::timestamptz,'2026-10-11'::timestamptz)),
 fixture_active_imports AS (SELECT id AS import_id FROM fixture_imports), '''


class SearchSQLTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config=Path('/home/ubuntu/seatraces-osm/reader.json')
        if not config.is_file():
            raise unittest.SkipTest('Server-only SQL regression requires its existing reader.json')
        cls.gateway = Gateway(json.loads(config.read_text()))

    def query(self, aliases=('osm:node/1',), **params):
        params.setdefault('q','东京塔')
        sql,args = search_sql(parse_search({k:[str(v)] for k,v in params.items()}),list(aliases))
        sql = (PREFIX + sql.removeprefix('WITH ')).replace('osm.poi ','fixture_poi ')
        sql = sql.replace('osm.active_imports ','fixture_active_imports ').replace('osm.imports ','fixture_imports ')
        return self.gateway.execute(sql,{**args,'fixtures':FIXTURES})

    def test_alias_extends_source_matches(self):
        self.assertEqual({r['id'] for r in self.query()}, {'osm:node/1','osm:node/2','osm:node/3','osm:node/4'})

    def test_alias_outside_region_does_not_hide_local_matches(self):
        self.assertEqual([r['id'] for r in self.query(region='china')],['osm:node/2'])

    def test_category_and_subtype_apply_to_both_sources(self):
        self.assertEqual([r['id'] for r in self.query(category='accommodation',subcategory='hostel')],['osm:node/3'])
        self.assertEqual({r['id'] for r in self.query(category='scenic')},{'osm:node/1','osm:node/2'})

    def test_nearby_filter_applies_to_alias_and_source_matches(self):
        self.assertEqual([r['id'] for r in self.query(lng=121.49,lat=31.24,radius=500)],['osm:node/2'])

    def test_two_character_name_search_keeps_alias_matches(self):
        self.assertEqual({r['id'] for r in self.query(q='塔楼')},{'osm:node/1','osm:node/7'})

    def test_cross_extract_duplicate_is_removed(self):
        rows=self.query()
        self.assertEqual(len(rows),len({r['id'] for r in rows}))
        self.assertEqual(next(r for r in rows if r['id']=='osm:node/2')['extract_region'],'taiwan')

    def test_stale_alias_does_not_hide_source_results(self):
        self.assertEqual({r['id'] for r in self.query(aliases=('osm:node/99',))},{'osm:node/2','osm:node/3','osm:node/4'})

    def test_limit_and_source_only_search(self):
        self.assertEqual(len(self.query(limit=2)),2)
        self.assertEqual({r['id'] for r in self.query(aliases=())},{'osm:node/2','osm:node/3','osm:node/4'})

    def test_nearby_knn_keeps_category_region_radius_and_dedup(self):
        rows=self.query(q='',aliases=(),region='china',category='scenic',lng=121.49,lat=31.24,radius=500,limit=2)
        self.assertEqual({r['id'] for r in rows},{'osm:node/2','osm:node/7'})
        self.assertTrue(all(r['distance_m']<=500 for r in rows))


if __name__=='__main__': unittest.main()
