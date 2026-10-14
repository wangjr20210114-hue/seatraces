import unittest
from containment_catalog import annotate_containment

class Gateway:
    def execute(self,sql,args=None):
        if 'containment_active' in sql:return [{'build_id':'fixture'}]
        return [dict(id='osm:node/1',geometry_state='mapped_point',parent_id='osm:way/2',
          natural_parent_id='osm:way/10',root_id='osm:relation/3',depth=8,natural_depth=10,depth_limited=True,
          child_count=None,children_by_category=None),
          dict(id='osm:way/99',geometry_state='unavailable_geometry',parent_id=None,
          natural_parent_id=None,root_id=None,depth=None,natural_depth=None,depth_limited=None,
          child_count=None,children_by_category=None)]

class ReaderTests(unittest.TestCase):
    def test_publish_product_parent_and_preserve_other_sources_and_categories(self):
        original=[dict(id='osm:node/1',category='food',parentId='old',relationships=[{'type':'part_of','parentId':'old'}],siteHierarchy={'parentIds':['site']}),
                  dict(id='osm:way/99',category='attraction',parentId='guess')]
        items=annotate_containment(Gateway(),original)
        self.assertEqual(items[0]['parentId'],'osm:way/2')
        self.assertEqual(items[0]['hierarchyLevel'],8)
        self.assertEqual(items[0]['category'],'food')
        self.assertEqual(items[0]['relationships'][0]['parentId'],'old')
        self.assertEqual(items[0]['siteHierarchy']['parentIds'],['site'])
        self.assertEqual(items[0]['geometricHierarchy']['naturalDepth'],10)
        self.assertIsNone(items[1]['parentId'])
        self.assertEqual(items[1]['parentLookup']['status'],'unknown')

if __name__=='__main__':unittest.main()
