import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from receive_parts_server import run


class TransferTests(unittest.TestCase):
    def test_corrupt_range_cannot_be_activated_and_complete_file_is_verified(self):
        chunks = [b'first range', b'second range']
        whole = b''.join(chunks)
        manifest = {'path':'test.osm.pbf', 'bytes':len(whole), 'sha256':hashlib.sha256(whole).hexdigest(), 'parts':[]}
        offset = 0
        for chunk in chunks:
            manifest['parts'].append({'offset':offset, 'bytes':len(chunk), 'sha256':hashlib.sha256(chunk).hexdigest()})
            offset += len(chunk)
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                run(root, manifest, 'receive', 0, io.BytesIO(b'wrong range'))
            self.assertEqual(run(root, manifest, 'status')['complete'], [])
            with self.assertRaisesRegex(ValueError, 'Truncated'):
                run(root, manifest, 'receive', 0, io.BytesIO(chunks[0][:3]))
            self.assertEqual(run(root, manifest, 'status', 0)['partial_bytes']['0'],3)
            run(root, manifest, 'receive', 0, io.BytesIO(chunks[0][3:]), offset=3)
            run(root, manifest, 'receive', 1, io.BytesIO(chunks[1]))
            self.assertEqual(run(root, manifest, 'status')['complete'], [0, 1])
            with patch('receive_parts_server.shutil.disk_usage') as space:
                space.return_value.free = 20 * 1024**3
                self.assertTrue(run(root, manifest, 'assemble')['verified'])
            self.assertEqual((root / manifest['path']).read_bytes(), whole)
            replay=run(root, manifest, 'assemble')
            self.assertTrue(replay['already_complete'])
            self.assertEqual(replay['sha256'],manifest['sha256'])
            with self.assertRaisesRegex(ValueError, 'Truncated'):
                run(root, manifest, 'receive', 1, io.BytesIO(b''))


if __name__ == '__main__':
    unittest.main()
