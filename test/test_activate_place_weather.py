"""Isolated activation safety tests; no production or provider access."""
from pathlib import Path
from unittest.mock import patch
import hashlib,io,json,sys,tempfile,types,unittest

ROOT=Path(__file__).resolve().parent.parent
class DB:
    def __init__(self,owner='capqa_fixture_a'):self.queries=[];self.owner=owner
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def execute(self,sql,values=None):self.queries.append((sql,values));return self
    def fetchone(self):return (self.owner,) if self.queries[-1][0].startswith('SELECT username') else (5121,)

class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.m=types.ModuleType('activation');exec(compile((ROOT/'deploy/activate-place-weather.py').read_text(encoding='utf8'),'activation.py','exec'),self.m.__dict__)
        self.m.ROOT=self.root;self.m.STATE=self.root/'state';self.m.STATE.mkdir();(self.root/'backups').mkdir()
        self.old=b'DATABASE_URL=fixture\nSES_SECRET_KEY=preserved-fixture\nMAIL_OUTBOX_KEY=existing-fixture\nEMBEDDING_ENABLED=false\n'
        self.env=self.root/'backend.env';self.env.write_bytes(self.old)
        self.record=self.m.STATE/(self.m.COMMIT+'.json');self.record.write_text(json.dumps({'phase':'completed','commit':self.m.COMMIT,'mailActivation':{'phase':'completed'}}))
        model=self.root/'cache/models/bge-small-zh-v1.5/config.json';model.parent.mkdir(parents=True);model.write_bytes(b'model-fixture')
        self.m.MODEL_FILES={'config.json':hashlib.sha256(b'model-fixture').hexdigest()}
        self.commands=[];self.db=DB();self.m.connection=lambda:self.db
        def run(args,**kw):
            self.commands.append(args)
            return ('seatraces-business:git-'+self.m.COMMIT[:12]).encode() if args[1]=='inspect' else b'{"amap":true,"semantic":false}'
        self.m.run=run;self.m.health=lambda:None;self.m.acceptance=lambda:{'officialAlerts':'not_configured'}
        self.m.backend_state=lambda:{'pid':123456,'startedAt':'same','oom':False}
        self.real_read=Path.read_text;self.rss=200000
        def read(path,*a,**kw):return 'VmRSS: '+str(self.rss)+' kB\n' if str(path).replace('\\','/').endswith('/proc/123456/status') else self.real_read(path,*a,**kw)
        fake=types.SimpleNamespace(flock=lambda *x:None,LOCK_EX=1,LOCK_NB=2)
        self.patches=[patch.dict(sys.modules,{'fcntl':fake}),patch.object(self.m.os,'fchmod',lambda *a:None,create=True),
                      patch.object(Path,'read_text',read),patch.object(self.m,'print',lambda *a,**k:None,create=True)]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    def result(self):return json.loads(self.record.read_text())['placeWeatherActivation']
    def test_activates_without_touching_mail_or_database_settings(self):
        self.m.activate();v=self.result();self.assertEqual(v['phase'],'completed');self.assertTrue(v['auditRecorded'])
        self.assertEqual(self.env.read_bytes(),self.old.replace(b'EMBEDDING_ENABLED=false',b'EMBEDDING_ENABLED=true'))
        self.assertEqual(json.loads(self.record.read_text())['mailActivation']['phase'],'completed')
        self.assertEqual(v['backendPeakRssMiB'],195);self.assertNotIn('preserved-fixture',self.record.read_text())
        self.assertEqual(list((self.root/'backups').iterdir())[0].read_bytes(),self.old)
    def test_failed_live_acceptance_restores_original_config(self):
        self.m.acceptance=lambda:(_ for _ in ()).throw(RuntimeError('SEMANTIC_RECALL_FAILED'))
        self.m.activate();self.assertEqual(self.result()['phase'],'rolled_back');self.assertEqual(self.env.read_bytes(),self.old)
    def test_restart_during_acceptance_rolls_back(self):
        calls=[]
        def state():calls.append(1);return {'pid':123456,'startedAt':str(len(calls)),'oom':False}
        self.m.backend_state=state;self.m.activate();self.assertEqual(self.result()['error'],'BACKEND_RESTARTED_DURING_ACCEPTANCE')
    def test_insufficient_memory_margin_rolls_back(self):
        self.rss=600000;self.m.activate();self.assertEqual(self.result()['error'],'BACKEND_MEMORY_MARGIN_TOO_SMALL')
    def test_wrong_running_image_does_not_write_configuration(self):
        self.m.run=lambda *a,**k:b'unreviewed-image'
        with self.assertRaisesRegex(RuntimeError,'REVIEWED_IMAGE_CHANGED'):self.m.activate()
        self.assertEqual(self.env.read_bytes(),self.old)
    def test_changed_model_is_rejected_before_activation(self):
        self.m.MODEL_FILES={'config.json':'0'*64}
        with self.assertRaisesRegex(RuntimeError,'PINNED_MODEL_CHECK_FAILED'):self.m.activate()
        self.assertEqual(self.env.read_bytes(),self.old)
    def test_missing_map_key_does_not_write_configuration(self):
        original=self.m.run
        self.m.run=lambda a,**k:b'{"amap":false}' if a[1]=='exec' else original(a,**k)
        with self.assertRaisesRegex(RuntimeError,'EXISTING_AMAP_KEY_MISSING'):self.m.activate()
        self.assertEqual(self.env.read_bytes(),self.old)
    def test_duplicate_setting_is_replaced_once_and_comments_preserved(self):
        new=self.m.enabled_env(b'# EMBEDDING_ENABLED=false\nexport EMBEDDING_ENABLED=false\n EMBEDDING_ENABLED=true\nAMAP_KEY=keep\n')
        self.assertEqual(new,b'# EMBEDDING_ENABLED=false\nAMAP_KEY=keep\nEMBEDDING_ENABLED=true\n')
    def test_cleanup_rejects_an_identity_mismatch(self):
        self.db.owner='formal-user'
        with self.assertRaisesRegex(RuntimeError,'FIXTURE_IDENTITY_MISMATCH'):
            self.m.cleanup({'users':[{'id':'isolated-id','username':'capqa_fixture_a'}],'cityKey':'capqa_fixture'})
        self.assertFalse(any(q.startswith('DELETE') for q,_ in self.db.queries))
    def test_cleanup_only_targets_exact_fixture_ids_and_cache_key(self):
        self.m.cleanup({'users':[{'id':'isolated-id','username':'capqa_fixture_a'}],'cityKey':'capqa_fixture'})
        deletes=[(q,v) for q,v in self.db.queries if q.startswith('DELETE')]
        self.assertEqual(len(deletes),5);self.assertTrue(all('WHERE' in q for q,v in deletes))
        self.assertEqual(deletes[-1][1],('capqa_fixture',))
    def test_expiry_cleanup_path_validation_accepts_only_generated_files(self):
        self.assertTrue(self.m.valid_cleanup_file(Path('/var/lib/seatraces/place-weather/fixture-012345abcdef.json')))
        for path in ['/tmp/fixture-012345abcdef.json','/var/lib/seatraces/place-weather/fixture-formal.json','/var/lib/seatraces/place-weather/fixture-012345abcdefxjson']:
            self.assertFalse(self.m.valid_cleanup_file(Path(path)))

if __name__=='__main__':unittest.main()
