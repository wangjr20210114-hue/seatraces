"""验证地点快照导入。"""
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid
import psycopg
from psycopg import sql
from download import digest
from extract import properties

spec=importlib.util.spec_from_file_location('osm_importer',Path(__file__).with_name('import.py'))
loader=importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)
ROOT=Path(__file__).resolve().parents[2]


class ImportTests(unittest.TestCase):
    def test_atomic_failure_idempotence_and_snapshot_switch(self):
        config=json.loads((ROOT/'.runtime/local.json').read_text())
        params=dict(host='127.0.0.1',port=config['port'],user='seatraces',password=config['password'],connect_timeout=5)
        database='osm_qa_'+uuid.uuid4().hex[:12]
        scratch=ROOT/'.runtime/osm-tests'
        scratch.mkdir(exist_ok=True)
        with psycopg.connect(dbname='postgres',autocommit=True,**params) as admin:
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
            try:
                with tempfile.TemporaryDirectory(dir=scratch) as directory:
                    base=Path(directory).resolve()
                    self.assertTrue(base.is_relative_to(scratch.resolve()))
                    snapshot=base/'sample.jsonl.gz'
                    def fixture(name,pbf_hash,total):
                        row=properties({'name':name,'name:en':'A "quoted" alias','tourism':'attraction'})
                        row.update(id='osm:node/1',osm_type='node',osm_id=1,lon=120.0,lat=31.0,geometry_kind='Point',coordinate_role='mapped_point')
                        with gzip.open(snapshot,'wt',encoding='utf8') as stream: stream.write(json.dumps(row,ensure_ascii=False)+'\n')
                        meta={'format':'seatraces-osm-poi-v1','pbf_sha256':pbf_hash*64,'output_sha256':digest(snapshot,'sha256'),'total':total,'pbf_timestamp':'2026-10-09T20:21:04Z'}
                        snapshot.with_suffix('.gz.json').write_text(json.dumps(meta))
                    with psycopg.connect(dbname=database,**params) as conn:
                        fixture("甲'园\\别名",'a',1)
                        self.assertEqual(loader.load(snapshot,'test-fixture',conn),1)
                        self.assertEqual(loader.load(snapshot,'test-fixture',conn),1)
                        self.assertEqual(conn.execute('SELECT count(*) FROM osm.poi').fetchone()[0],1)
                        conn.commit()
                        fixture('同一来源的不同产物','a',1)
                        with self.assertRaisesRegex(ValueError,'different processed artifact'): loader.load(snapshot,'test-fixture',conn)
                        fixture('失败的新版本','b',2)
                        with self.assertRaisesRegex(ValueError,'row count'): loader.load(snapshot,'test-fixture',conn)
                        self.assertEqual(conn.execute('SELECT name FROM osm.current_poi').fetchone()[0],"甲'园\\别名")
                        self.assertEqual(conn.execute('SELECT count(*) FROM osm.imports').fetchone()[0],1)
                        conn.commit()
                        fixture('乙园','b',1)
                        loader.load(snapshot,'test-fixture',conn)
                        self.assertEqual(conn.execute('SELECT name FROM osm.current_poi').fetchone()[0],'乙园')
                        self.assertEqual(conn.execute('SELECT count(*) FROM osm.poi').fetchone()[0],2)
                        self.assertIsNone(conn.execute('SELECT opening_hours FROM osm.current_poi').fetchone()[0])
                        ranked=conn.execute("""SELECT name FROM (VALUES
                          ('AAA Shop',ARRAY[]::text[]),
                          ('马累',ARRAY['Malé']::text[]),
                          ('Hulhumalé Hotel',ARRAY[]::text[])
                        ) AS candidate(name,aliases)
                        ORDER BY osm.name_match_cost(name,aliases,'MALÉ'),name""").fetchall()
                        self.assertEqual([row[0] for row in ranked],['马累','Hulhumalé Hotel','AAA Shop'])
                        self.assertEqual(conn.execute("SELECT osm.name_match_cost('A% Museum',ARRAY[]::text[],'%')").fetchone()[0],8)
                        self.assertEqual(conn.execute("SELECT osm.name_match_cost('Anywhere',NULL,'')").fetchone()[0],0)
            finally:
                self.assertRegex(database,r'^osm_qa_[0-9a-f]{12}$')
                admin.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(database)))


if __name__=='__main__': unittest.main()
