"""验证OSM 数据下载和提取。"""

import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import download
from extract import properties


class Response(io.BytesIO):
    def __init__(self, data=b'', headers=None, status=200):
        super().__init__(data)
        self.headers = headers or {}
        self.status = status


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.scratch = (Path(__file__).resolve().parents[2] / '.runtime' / 'osm-tests')
        self.scratch.mkdir(parents=True,exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=self.scratch)
        self.root = Path(self.tmp.name)
        self.data = b'osm-test-content'
        self.md5 = hashlib.md5(self.data).hexdigest()
        self.name = 'china-'+self.md5+'.osm.pbf'

    def tearDown(self):
        assert self.root.resolve().is_relative_to(self.scratch.resolve())
        self.tmp.cleanup()

    def request(self,url,headers=None,method=None):
        if url.endswith('.md5'):
            return Response((self.md5+'  china-latest.osm.pbf').encode())
        if method == 'HEAD':
            return Response(headers={'Content-Length':str(len(self.data))})
        start,end=map(int,headers['Range'][6:].split('-'))
        return Response(self.data[start:end+1],{'Content-Range':f'bytes {start}-{end}/{len(self.data)}'},206)

    def test_resume_and_verify(self):
        (self.root/(self.name+'.part')).write_bytes(self.data[:5])
        with patch.object(download,'request',self.request):
            result=download.download('china',self.root,reserve_gib=0)
        self.assertTrue(result['verified'])
        self.assertEqual((self.root/self.name).read_bytes(),self.data)
        self.assertEqual(result['sha256'],hashlib.sha256(self.data).hexdigest())

    def test_wrong_range_is_not_accepted(self):
        def wrong(url,headers=None,method=None):
            response=self.request(url,headers,method)
            if headers: response.headers['Content-Range']='bytes 1-2/3'
            return response
        with patch.object(download,'request',wrong),self.assertRaisesRegex(RuntimeError,'Content-Range'):
            download.download('china',self.root,reserve_gib=0)
        self.assertFalse((self.root/self.name).exists())

    def test_checksum_mismatch_never_activates(self):
        (self.root/(self.name+'.part')).write_bytes(b'x'*len(self.data))
        with patch.object(download,'request',self.request),self.assertRaisesRegex(RuntimeError,'Checksum'):
            download.download('china',self.root,reserve_gib=0)
        self.assertFalse((self.root/'china-manifest.json').exists())

    def test_disk_reserve_checked(self):
        with patch.object(download,'request',self.request),patch.object(download.shutil,'disk_usage',return_value=type('Usage',(),{'free':1})()),self.assertRaisesRegex(RuntimeError,'space'):
            download.download('china',self.root,reserve_gib=1)
        self.assertFalse((self.root/(self.name+'.part')).exists())


class PlaceTests(unittest.TestCase):
    def test_hotel_and_missing_facts(self):
        p=properties({'name':'测试酒店','tourism':'hotel'})
        self.assertEqual(p['category'],'accommodation')
        self.assertIsNone(p['opening_hours'])
        self.assertIsNone(p['city'])
        self.assertIsNone(p['fee'])

    def test_private_access_not_selectable(self):
        self.assertFalse(properties({'name':'私园','tourism':'attraction','access':'private'})['selectable'])

    def test_disused_and_unnamed_excluded(self):
        self.assertIsNone(properties({'name':'旧站','railway':'station','disused':'yes'}))
        self.assertIsNone(properties({'tourism':'hotel'}))

    def test_multilingual_aliases(self):
        p=properties({'name':'The Bund','name:zh':'外滩','alt_name':'外灘;上海外滩','tourism':'attraction'})
        self.assertEqual(p['name'],'外滩')
        self.assertIn('The Bund',p['aliases'])
        self.assertIn('外灘',p['aliases'])


if __name__=='__main__':
    unittest.main()
