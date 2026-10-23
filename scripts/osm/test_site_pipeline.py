"""验证OSM site 数据处理流程。"""

import tempfile
from pathlib import Path
import unittest
from rebuild_sites import scan_sites,scan_members
from site_hierarchy import build_graph


class SitePipelineTests(unittest.TestCase):
    def test_raw_relation_without_catalog_parent_and_missing_member(self):
        xml='''<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">
        <node id="1" lat="30" lon="120" version="1" timestamp="2026-10-09T00:00:00Z"><tag k="name" v="Cafe"/><tag k="amenity" v="cafe"/></node>
        <way id="2" version="1" timestamp="2026-10-09T00:00:00Z"><nd ref="1"/><tag k="name" v="Boundary"/></way>
        <relation id="100" version="1" timestamp="2026-10-09T00:00:00Z"><member type="node" ref="1" role=""/><member type="way" ref="2" role="perimeter"/><member type="node" ref="999" role=""/><tag k="type" v="site"/><tag k="name" v="Park"/><tag k="leisure" v="park"/></relation>
        <relation id="200" version="1" timestamp="2026-10-09T00:00:00Z"><member type="way" ref="2" role="outer"/><tag k="type" v="multipolygon"/></relation>
        </osm>'''
        runtime=Path(__file__).resolve().parents[2]/'.runtime/site-tests'
        runtime.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='fixture-',dir=runtime) as folder:
            assert Path(folder).resolve().is_relative_to(runtime.resolve())
            root=Path(folder);pbf=root/'fixture.osm';pbf.write_text(xml,encoding='utf8')
            source={'region':'fixture','path':str(pbf),'pbf_sha256':'fixture'}
            sites=scan_sites(source,root,lambda *a,**k:None)['sites']
            self.assertEqual(list(sites),['osm:relation/100'])
            needed={'n':{1,999},'w':{2},'r':set()}
            objects=scan_members(source,needed,root,lambda *a,**k:None)['objects']
            self.assertEqual(set(objects),{'osm:node/1','osm:way/2'})
            self.assertEqual(objects['osm:node/1']['tags']['amenity'],'cafe')
            self.assertEqual(scan_sites(source,root,lambda *a,**k:None)['sites'],sites)
            graph=build_graph(sites,{'osm:node/1':{'category':'food'}})
            self.assertEqual(graph['counts']['rawMembers'],3)
            self.assertEqual(graph['counts']['acceptedEdges'],2)


if __name__=='__main__':unittest.main()
