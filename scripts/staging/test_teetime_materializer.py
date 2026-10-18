"""Linux trusted-writer tests; no model, network, or container control."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from teetime_git_objects import build_git_objects
from teetime_materialization_frame import encode_frame
from teetime_snapshot import SnapshotFile, snapshot_manifest
from teetime_materializer import materialize


class MaterializerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)/'source'
        self.root.mkdir()
        self.files = (SnapshotFile('data.bin', '100644', b'\x00\xffbinary'),
                      SnapshotFile('src/run.sh', '100755', b'#!/bin/sh\nexit 0\n'))
        self.ids = {'expected_manifest_hash': hashlib.sha256(snapshot_manifest(self.files).encode()).hexdigest(),
                    'expected_tree': build_git_objects(self.files, expected_format='sha1').root_tree}
        self.raw = encode_frame(self.files, **self.ids)

    def tearDown(self):
        self.temp.cleanup()

    def test_linux_uid_and_descriptor_operations_required(self):
        self.assertEqual(os.name, 'posix', 'run this required suite in Linux as UID1001')
        self.assertEqual(os.getuid(), 1001)
        self.assertIn(os.open, os.supports_dir_fd)

    def test_exact_binary_and_modes_despite_umask(self):
        old = os.umask(0o077)
        try:
            materialize(self.root, self.raw, **self.ids)
        finally:
            os.umask(old)
        for item in self.files:
            target = self.root/item.path
            self.assertEqual(target.read_bytes(), item.content)
            self.assertEqual(target.stat().st_mode & 0o777, int(item.git_mode[-3:], 8))
        self.assertEqual({p.relative_to(self.root).as_posix() for p in self.root.rglob('*')},
                         {'data.bin', 'src', 'src/run.sh'})

    def test_full_validation_precedes_any_write(self):
        for raw, ids in [(self.raw+b' ', self.ids), (self.raw, {**self.ids, 'expected_tree': '0'*40})]:
            with self.assertRaises(ValueError):
                materialize(self.root, raw, **ids)
            self.assertEqual(list(self.root.iterdir()), [])

    def test_nonempty_root_and_symlink_refused(self):
        (self.root/'existing').write_bytes(b'unchanged')
        with self.assertRaises(ValueError):
            materialize(self.root, self.raw, **self.ids)
        self.assertEqual((self.root/'existing').read_bytes(), b'unchanged')
        link = Path(self.temp.name)/'link'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            materialize(link, self.raw, **self.ids)

    def test_short_writes_complete(self):
        original = os.write
        with patch('teetime_materializer.os.write', side_effect=lambda fd, data: original(fd, data[:2])):
            materialize(self.root, self.raw, **self.ids)
        self.assertEqual((self.root/'data.bin').read_bytes(), self.files[0].content)

    def test_zero_write_and_fsync_failure_invalidate_partial_root(self):
        for operation in ['write', 'fsync']:
            with self.subTest(operation=operation):
                if operation == 'write':
                    mocked = patch('teetime_materializer.os.write', return_value=0)
                else:
                    mocked = patch('teetime_materializer.os.fsync', side_effect=OSError('injected'))
                with mocked:
                    with self.assertRaises(OSError):
                        materialize(self.root, self.raw, **self.ids)
                self.assertTrue(list(self.root.iterdir()))
                with self.assertRaises(ValueError):
                    materialize(self.root, self.raw, **self.ids)
                # Simulate controller disposal, never resume the partial root.
                for path in self.root.iterdir():
                    path.unlink()

    def test_empty_snapshot(self):
        files = ()
        ids = {'expected_manifest_hash': hashlib.sha256(snapshot_manifest(files).encode()).hexdigest(),
               'expected_tree': build_git_objects(files, expected_format='sha1').root_tree}
        materialize(self.root, encode_frame(files, **ids), **ids)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
