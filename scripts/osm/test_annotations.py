"""验证地点补充资料导入。"""

import unittest
from import_annotations import validate

class AnnotationTests(unittest.TestCase):
    def row(self):
        return {'placeId':'osm:relation/4247312','field':'openingHours','value':'09:00-18:00',
                'sourceName':'Test official source fixture','sourceUrl':'https://example.org/visit','sourceTimestamp':'2026-01-01T00:00:00Z'}
    def test_valid_source_record(self):
        self.assertEqual(len(validate({'facts':[self.row()]})[1]),1)
    def test_invalid_sources_dates_and_ids(self):
        for patch in ({'sourceUrl':'javascript:alert(1)'},{'sourceName':''},{'sourceTimestamp':'2099-01-01T00:00:00Z'},
                      {'sourceTimestamp':'2026-01-01'},{'placeId':'bad'},{'field':'password'},{'value':None}):
            with self.assertRaises(ValueError):validate({'facts':[{**self.row(),**patch}]})
    def test_prices_need_currency_and_cannot_be_negative(self):
        for value in (-1,{'amount':-1,'currency':'CNY'},{'amount':0},{'amount':True,'currency':'CNY'}):
            with self.assertRaises(ValueError):validate({'facts':[{**self.row(),'field':'ticketPrice','value':value}]})
        validate({'facts':[{**self.row(),'field':'ticketPrice','value':{'amount':0,'currency':'CNY'}}]})

if __name__=='__main__':unittest.main()
