"""验证景区几何提取。"""

import unittest
from shapely.geometry import Point, Polygon
from scenic_geometry import infer, polygon_from_members, scenic_container


class GeometryTests(unittest.TestCase):
    def test_historic_site_boundary_is_not_an_administrative_boundary(self):
        self.assertTrue(scenic_container({'rawTags':{'boundary':'historic','historic':'castle'}}))
        self.assertFalse(scenic_container({'rawTags':{'boundary':'administrative','tourism':'attraction'}}))
    def place(self, pid, name, **more):
        return {'id':pid, 'name':name, 'city':'测试城', 'lng':2, 'lat':2, 'rawTags':{}, **more}

    def test_hole_and_no_semantic_assumption(self):
        parent=self.place('osm:way/1','公园',rawTags={'leisure':'park'})
        child=self.place('osm:node/2','亭')
        hole=self.place('osm:node/3','独立馆',lng=5,lat=5)
        polygon=Polygon([(0,0),(10,0),(10,10),(0,10)],holes=[[(4,4),(6,4),(6,6),(4,6)]])
        results=infer([parent,child,hole],{parent['id']:polygon}, {})
        self.assertEqual(results[1]['status'],'spatial_candidate')
        self.assertIsNone(results[1]['parentId'])
        self.assertEqual(results[2]['candidates'],[])

    def test_representative_point_not_used_as_full_way(self):
        parent=self.place('osm:way/1','公园',rawTags={'leisure':'park'})
        child=self.place('osm:way/2','大面积独立景区')
        results=infer([parent,child],{parent['id']:Polygon([(0,0),(10,0),(10,10),(0,10)])},{})
        self.assertEqual(results[1]['status'],'unknown')
        self.assertFalse(results[1]['geometryAvailable'])

    def test_site_members_and_cycles(self):
        a=self.place('osm:relation/1','园',rawTags={'leisure':'park'})
        b=self.place('osm:relation/2','馆',rawTags={'tourism':'museum'})
        members={a['id']:[{'type':'r','ref':2,'role':''}]}
        self.assertEqual(infer([a,b],{},members)[1]['parentId'],a['id'])
        members[b['id']]=[{'type':'r','ref':1,'role':''}]
        self.assertTrue(all(r['status']=='conflict' for r in infer([a,b],{},members)))

    def test_relation_holes_and_incomplete_rings(self):
        nodes={'1':[0,0],'2':[10,0],'3':[10,10],'4':[0,10], '5':[4,4],'6':[6,4],'7':[6,6],'8':[4,6]}
        ways={'1':{'nodes':[1,2,3,4,1]},'2':{'nodes':[5,6,7,8,5]}}
        members=[{'type':'w','ref':1,'role':'outer'},{'type':'w','ref':2,'role':'inner'}]
        polygon=polygon_from_members(members,ways,nodes)
        self.assertTrue(polygon.covers(Point(2,2)))
        self.assertFalse(polygon.covers(Point(5,5)))
        ways['1']['nodes']=[1,2,3]
        with self.assertRaises(ValueError):polygon_from_members(members,ways,nodes)


if __name__=='__main__':unittest.main()
