import unittest
from site_hierarchy import build_graph, cyclic_pairs


def site(n, members):
    return ('osm:relation/'+str(n), {'tags':{'type':'site','name':'Site '+str(n)},'members':members})


def member(kind, n, role=''):
    return dict(type=kind,ref=n,role=role)


class SiteHierarchyTests(unittest.TestCase):
    def test_all_existing_categories_keep_identity_and_attach(self):
        categories=['attraction','heritage','nature','leisure','accommodation','food',
                    'rest','transport','shopping','settlement','service']
        objects={'osm:node/'+str(i):{'category':c} for i,c in enumerate(categories,1)}
        graph=build_graph(dict([site(100,[member('n',i) for i in range(1,12)])]),objects)
        self.assertEqual(graph['counts']['acceptedEdges'],11)
        parent=next(s for s in graph['summaries'] if s['id']=='osm:relation/100')
        self.assertEqual(parent['children_by_category'],dict.fromkeys(categories,1))
        self.assertEqual([objects['osm:node/'+str(i)]['category'] for i in range(1,12)],categories)

    def test_parent_does_not_need_to_exist_in_catalog(self):
        graph=build_graph(dict([site(100,[member('n',1)])]),{'osm:node/1':{'category':'food'}})
        self.assertEqual(graph['edges'][0]['parent_id'],'osm:relation/100')

    def test_nested_sites_and_multiple_parents_preserved(self):
        sites=dict([site(100,[member('r',200),member('n',1)]),site(200,[member('n',1)])])
        graph=build_graph(sites,{})
        item=next(s for s in graph['summaries'] if s['id']=='osm:node/1')
        self.assertEqual(item['parent_ids'],['osm:relation/100','osm:relation/200'])
        self.assertEqual(item['membership_status'],'multiple_parents')
        self.assertEqual(graph['counts']['acceptedEdges'],3)

    def test_technical_members_preserved_but_not_place_children(self):
        graph=build_graph(dict([site(100,[member('w',1,'perimeter'),member('n',2,'label'),member('n',3,'entrance')])]),{})
        self.assertEqual(len(graph['members']),3)
        self.assertEqual(graph['counts']['technicalMembers'],2)
        self.assertEqual(graph['edges'][0]['child_id'],'osm:node/3')

    def test_cycle_quarantines_only_involved_edges(self):
        sites=dict([site(100,[member('r',200)]),site(200,[member('r',100),member('n',1)])])
        graph=build_graph(sites,{})
        self.assertEqual(graph['counts']['cycleEdges'],2)
        self.assertEqual(graph['counts']['acceptedEdges'],1)
        self.assertEqual(cyclic_pairs(iter([('a','b'),('b','a'),('b','c')])),{('a','b'),('b','a')})

    def test_multipolygon_is_not_a_site(self):
        with self.assertRaises(ValueError):
            build_graph({'osm:relation/100':{'tags':{'type':'multipolygon'},'members':[]}}, {})

    def test_duplicate_members_retain_roles_without_duplicate_children(self):
        graph=build_graph(dict([site(100,[member('n',1),member('n',1,'part')])]),{})
        self.assertEqual(len(graph['members']),2)
        self.assertEqual(len(graph['edges']),1)
        self.assertEqual(graph['edges'][0]['roles'],['','part'])


if __name__=='__main__':
    unittest.main()
