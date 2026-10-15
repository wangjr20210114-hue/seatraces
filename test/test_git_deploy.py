"""Focused gateway checks; Windows stubs flock only, no server effects."""
import importlib.util,io,json,sys,tarfile,tempfile,unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock,patch

try:import fcntl
except ImportError:sys.modules['fcntl']=Mock(LOCK_EX=2,LOCK_NB=4,LOCK_UN=8)
spec=importlib.util.spec_from_file_location('gateway',Path(__file__).resolve().parents[1]/'deploy/deploy-from-git.py')
gateway=importlib.util.module_from_spec(spec);spec.loader.exec_module(gateway)

class GatewayTests(unittest.TestCase):
    def test_command_injection_rejected(self):
        for request in ('sh','deploy main','deploy '+'a'*40+'; id','status ../../etc/shadow','check\nid'):
            with self.assertRaises(RuntimeError):gateway.gateway(request)

    def test_archive_rejects_escape_and_symlink(self):
        for name,kind in (('../outside',tarfile.REGTYPE),('/etc/outside',tarfile.REGTYPE),('link',tarfile.SYMTYPE),('.env',tarfile.REGTYPE)):
            raw=io.BytesIO()
            with tarfile.open(fileobj=raw,mode='w') as archive:
                entry=tarfile.TarInfo(name);entry.type=kind;entry.linkname='/etc/passwd';archive.addfile(entry)
            with tempfile.TemporaryDirectory() as temp,self.assertRaises(RuntimeError):gateway.unpack(raw.getvalue(),Path(temp))

    def test_retry_clears_old_completion_before_starting_worker(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(gateway,'STATE',Path(temp)),patch.object(gateway.fcntl,'flock'),patch.object(gateway.os,'fchmod',create=True):
            commit='a'*40;record=Path(temp)/(commit+'.json')
            record.write_text(json.dumps({'phase':'completed','commit':commit,'pid':0}))
            def start(*args,**kwargs):
                self.assertEqual(json.loads(record.read_text())['phase'],'queued')
                return Mock(pid=123)
            with patch.object(gateway.subprocess,'Popen',side_effect=start),redirect_stdout(io.StringIO()):gateway.gateway('deploy '+commit)
            self.assertEqual(json.loads((Path(temp)/'current.json').read_text())['commit'],commit)

    def test_schema_inventory_includes_nested_sql(self):
        with patch.object(gateway,'git',return_value='100644 blob aaa\tserver/schema.sql\n100644 blob bbb\tserver/index.mjs\n100644 blob ccc\tserver/migrations/new.sql'):
            self.assertEqual(len(gateway.schema_tree('a'*40)),2)

    def test_git_network_failures_are_distinguished_from_permissions(self):
        network=gateway.git_failure('fetch','fatal: unable to access https://example.org/: Failed to connect to github.com: Connection timed out',128)
        self.assertTrue(network.transient)
        self.assertIn('Connection timed out',str(network))
        permission=gateway.git_failure('fetch',"error: cannot open '.git/FETCH_HEAD': Permission denied",128)
        self.assertFalse(permission.transient)
        self.assertIn('FETCH_HEAD',str(permission))

    def test_git_error_removes_url_passwords(self):
        error=gateway.git_failure('fetch','fatal: unable to access https://someone:secret-placeholder@github.com/repo',128)
        self.assertNotIn('secret-placeholder',str(error))

if __name__=='__main__':unittest.main()
