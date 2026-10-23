"""验证地点包含层级构建。"""

import unittest
from pathlib import Path
import json
import tempfile
from shapely.geometry import box, Point, Polygon, shape
from containment_hierarchy import cap_forest, infer_fixture
from containment_geometry import extract_geometries


class ContainmentTests(unittest.TestCase):
    def test_full_footprint_hole_boundary_and_original_categories(self):
        outer=Polygon([(0,0),(10,0),(10,10),(0,10)],holes=[[(4,4),(6,4),(6,6),(4,6)]])
        places=[dict(id=i,category=c) for i,c in [('park','attraction'),('hall','heritage'),('cafe','food'),('crossing','heritage'),('hole','accommodation'),('edge','rest'),('missing','attraction')]]
        g={'park':outer,'hall':box(1,1,3,3),'cafe':Point(2,2),'crossing':box(9,9,11,11),'hole':Point(5,5),'edge':Point(0,2)}
        result=infer_fixture(places,g)
        self.assertEqual(result['hall']['parent_id'],'park')
        self.assertEqual(result['cafe']['parent_id'],'hall')
        self.assertEqual(result['edge']['parent_id'],'park')
        self.assertTrue(all(i not in result for i in ['crossing','hole','missing']))
        self.assertEqual(places[2]['category'],'food')

    def test_equal_geometry_not_parent_and_deterministic_smallest(self):
        places=[dict(id=i,category='attraction') for i in ['z','a','large','p']]
        g={'z':box(0,0,4,4),'a':box(0,0,4,4),'large':box(-1,-1,5,5),'p':Point(2,2)}
        r=infer_fixture(places,g)
        self.assertEqual(r['a']['parent_id'],'large')
        self.assertEqual(r['z']['parent_id'],'large')
        self.assertEqual(r['p']['parent_id'],'a')

    def test_depth_cap_preserves_all_descendants_and_natural_parents(self):
        parents={str(i):str(i-1) for i in range(2,13)}
        r=cap_forest(parents)
        self.assertEqual(len(r),11)
        self.assertEqual(r['8']['parent_id'],'7')
        self.assertFalse(r['8']['depth_limited'])
        self.assertEqual(r['12']['parent_id'],'7')
        self.assertEqual(r['12']['natural_parent_id'],'11')
        self.assertEqual(r['12']['depth'],8)
        self.assertEqual(r['12']['natural_depth'],12)
        with self.assertRaises(ValueError):cap_forest({'a':'b','b':'a'})

    def test_administrative_boundary_is_not_scenic_parent(self):
        p=[dict(id='city',category='attraction',administrative=True),dict(id='hall',category='heritage')]
        self.assertEqual(infer_fixture(p,{'city':box(0,0,10,10),'hall':Point(1,1)}),{})

    def test_verified_palace_full_geometry(self):
        path=Path(__file__).resolve().parents[2]/'validation/palace-containment-20261012/geometry.geojson'
        if not path.exists():self.skipTest('public OSM evidence not present in this checkout')
        features=json.loads(path.read_text(encoding='utf8'))['features']
        p=[dict(id=f['properties']['id'],category='attraction') for f in features]
        r=infer_fixture(p,{f['properties']['id']:shape(f['geometry']) for f in features})
        self.assertEqual(r['osm:way/638449347']['parent_id'],'osm:relation/9511883')

    def test_streamed_area_reconstructs_boundary_and_preserves_hole(self):
        nodes=[(1,0,0),(2,0,10),(3,10,10),(4,10,0),(5,4,4),(6,4,6),(7,6,6),(8,6,4)]
        xml='<osm version="0.6">'+''.join(f'<node id="{i}" lon="{x}" lat="{y}" version="1"/>' for i,x,y in nodes)
        xml+=''.join('<way id="'+str(i)+'" version="1">'+''.join(f'<nd ref="{n}"/>' for n in refs)+'</way>' for i,refs in [(10,[1,2,3]),(11,[3,4,1]),(12,[5,6,7,8,5])])
        xml+='<relation id="100" version="1"><member type="way" ref="10" role="outer"/><member type="way" ref="11" role="outer"/><member type="way" ref="12" role="inner"/><tag k="type" v="boundary"/><tag k="boundary" v="historic"/><tag k="tourism" v="attraction"/><tag k="name" v="Park"/></relation></osm>'
        runtime=Path(__file__).resolve().parents[2]/'.runtime/containment-tests'
        runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=runtime) as folder:
            self.assertTrue(Path(folder).resolve().is_relative_to(runtime.resolve()))
            root=Path(folder);pbf=root/'fixture.osm';pbf.write_text(xml,encoding='utf8')
            src={'path':str(pbf),'region':'fixture','pbf_sha256':'fixture'}
            path,report=extract_geometries(src,root,'fixture',lambda *a,**k:None,disk_index=False)
            import gzip
            from shapely import from_wkb
            with gzip.open(path,'rt') as stream:rows=[json.loads(line) for line in stream]
            self.assertEqual(len(rows),1)
            geom=from_wkb(rows[0]['wkb'])
            self.assertTrue(geom.covers(Point(1,1)))
            self.assertFalse(geom.covers(Point(5,5)))
            self.assertEqual(extract_geometries(src,root,'fixture',lambda *a,**k:None)[1],report)


if __name__=='__main__':unittest.main()
