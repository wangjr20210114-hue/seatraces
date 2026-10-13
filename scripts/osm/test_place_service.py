import unittest
from place_service import parse_search, search_sql, present

class PlaceServiceTests(unittest.TestCase):
    def test_invalid_queries(self):
        for p in ({'q':['湖']},{'q':['西湖'],'lat':['31']},{'q':['西湖'],'lng':['NaN'],'lat':['31']},
                  {'q':['西湖'],'limit':['0']},{'q':['西湖'],'category':['evil']},{'q':['a','b']},
                  {'q':['西湖'],'lng':['120'],'lat':['31'],'radius':['Infinity']}):
            with self.assertRaises(ValueError): parse_search(p)
    def test_alias_and_bound_parameters(self):
        sql,params=search_sql(parse_search({'q':['东京塔']}),['osm:relation/4247312'])
        self.assertEqual(params['ids'],['osm:relation/4247312'])
        self.assertNotIn('东京塔',sql)
        sql,params=search_sql(parse_search({'q':["_%' OR true --"]}))
        self.assertEqual(params['pattern'],"%\\_\\%' OR true --%")
        self.assertNotIn('OR true',sql)
    def test_classification_filters_precede_limit(self):
        sql,p=search_sql(parse_search({'q':['酒店'],'category':['accommodation'],'subcategory':['hostel'],'region':['japan']}))
        self.assertEqual(p['categories'],['accommodation'])
        self.assertLess(sql.index('p.category=ANY'),sql.index('LIMIT'))
    def test_unknown_facts_remain_unknown(self):
        p=present({'id':'osm:node/1','name':'青旅','aliases':[],'category':'accommodation','subcategory':'hostel',
            'lon':139,'lat':35,'tags':{'tourism':'hostel'},'extract_region':'japan','source_timestamp':'2026-10-09',
            'opening_hours':None,'fee':None,'country_code':None})
        self.assertEqual(p['facts']['ticketPrice']['value'],None)
        self.assertEqual(p['facts']['openingHours']['status'],'unknown')
        self.assertEqual(p['countrySource'],'extract_region_hint')
        self.assertEqual(p['subcategoryLabel'],'青年旅舍')
        self.assertEqual(p['coord_system'],'WGS84')

    def test_numeric_fee_is_preserved_without_becoming_a_price(self):
        p=present({'id':'osm:node/1','name':'园林','aliases':[],'category':'attraction','subcategory':'garden',
            'lon':120,'lat':31,'tags':{},'extract_region':'china','source_timestamp':'2026-10-09',
            'opening_hours':None,'fee':'90','country_code':None})
        self.assertIsNone(p['facts']['fee']['value'])
        self.assertEqual(p['facts']['fee']['rawValue'],'90')
        self.assertIsNone(p['facts']['ticketPrice']['value'])

if __name__=='__main__': unittest.main()
