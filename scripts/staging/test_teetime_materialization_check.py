"""Linux inventory checks. Actual readonly Docker mount is a separate runtime gate."""
import errno
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from teetime_git_objects import build_git_objects
from teetime_materialization_check import fixture_assertions, read_candidate, require_readonly
from teetime_materialization_frame import encode_frame
from teetime_materializer import materialize
from teetime_snapshot import SnapshotFile, snapshot_manifest


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.files = (SnapshotFile('data.bin', '100644', b'\x00\xffbinary'),
                      SnapshotFile('index.html', '100644', b'<p>synthetic-artifact-ready</p>\n'),
                      SnapshotFile('src/run.sh', '100755', b'#!/bin/sh\nexit 0\n'))
        self.ids = {'expected_manifest_hash': hashlib.sha256(snapshot_manifest(self.files).encode()).hexdigest(),
                    'expected_tree': build_git_objects(self.files, expected_format='sha1').root_tree}
        materialize(self.root, encode_frame(self.files, **self.ids), **self.ids)

    def tearDown(self):
        self.temp.cleanup()

    def read(self):
        return read_candidate(self.root, expected_files=self.files, **self.ids)

    def test_complete_fixture_identity_and_fixed_assertions(self):
        self.assertEqual(self.read(), self.files)
        fixture_assertions(self.files)
        with self.assertRaises(ValueError):
            fixture_assertions(self.files[:-1])

    def test_missing_and_extra_inventory(self):
        path = self.root/'data.bin'
        path.unlink()
        with self.assertRaises(ValueError):
            self.read()
        path.write_bytes(self.files[0].content)
        path.chmod(0o644)
        (self.root/'unexpected').write_bytes(b'extra')
        with self.assertRaises(ValueError):
            self.read()

    def test_content_and_mode_drift(self):
        path = self.root/'index.html'
        path.write_bytes(b'x'*len(self.files[1].content))
        with self.assertRaises(ValueError):
            self.read()
        path.write_bytes(self.files[1].content)
        path.chmod(0o600)
        with self.assertRaises(ValueError):
            self.read()

    def test_symlink_hardlink_and_metadata_are_not_omitted(self):
        path = self.root/'data.bin'
        path.unlink()
        path.symlink_to(self.root/'index.html')
        with self.assertRaises(ValueError):
            self.read()
        path.unlink()
        os.link(self.root/'index.html', path)
        with self.assertRaises(ValueError):
            self.read()
        path.unlink()
        path.write_bytes(self.files[0].content)
        path.chmod(0o644)
        (self.root/'.codex').mkdir()
        with self.assertRaises(ValueError):
            self.read()

    def test_actual_writable_root_rejected_and_probe_removed(self):
        with self.assertRaisesRegex(ValueError, 'writable'):
            require_readonly(self.root)
        self.assertEqual(self.read(), self.files)

    def test_only_erofs_counts_as_readonly(self):
        original = os.open
        for number in [errno.EACCES, errno.EEXIST, errno.EROFS]:
            def opened(path, flags, *args, **kwargs):
                if path == '.materialization-readonly-probe':
                    raise OSError(number, 'injected')
                return original(path, flags, *args, **kwargs)
            with patch('teetime_materialization_check.os.open', side_effect=opened):
                if number == errno.EROFS:
                    self.assertEqual(require_readonly(self.root), 'EROFS')
                else:
                    with self.assertRaises(ValueError):
                        require_readonly(self.root)


if __name__ == '__main__':
    unittest.main()
