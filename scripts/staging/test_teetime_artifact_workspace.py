import errno
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from teetime_artifact_workspace import worker_tmpfs, workspace_diagnostic, require_readonly_workspace


class ArtifactWorkspaceTests(unittest.TestCase):
    def snapshot(self, root):
        return tuple((p.name, s.st_mode, s.st_uid, s.st_gid, s.st_dev, s.st_ino)
                     for p in sorted(root.iterdir(), key=lambda item: item.name) for s in [p.lstat()])

    def test_only_filesystem_canary_retains_a_writable_workspace_mount(self):
        self.assertIn('/workspace', worker_tmpfs(False))
        self.assertNotIn('/workspace', worker_tmpfs(True))
        for name in ['/workspace/.agents', '/workspace/.codex']:
            self.assertTrue(worker_tmpfs(True)[name].startswith('ro,'))
        with self.assertRaises(ValueError): worker_tmpfs('artifact')

    def test_bounded_diagnostic_never_returns_unknown_names_or_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['.agents', '.codex']: (root/name).mkdir()
            before = self.snapshot(root); uid = (root/'.agents').stat().st_uid
            self.assertEqual(workspace_diagnostic(root, before, uid),
                             {'category':'unchanged','entryCount':2,'maskEntryCount':0})
            (root/'.codex/private-secret-name').write_text('private-data')
            value = workspace_diagnostic(root, before, uid)
            self.assertEqual(value['category'], 'mask_not_empty')
            self.assertNotIn('private', str(value))
            for index in range(30): (root/('unknown-'+str(index))).touch()
            value = workspace_diagnostic(root, before, uid)
            self.assertEqual(value['entryCount'], 17)
            self.assertEqual(value['category'], 'inventory_changed')
            self.assertEqual(workspace_diagnostic(root, None, uid)['category'], 'inspection_failed')

    def test_actual_readonly_errors_are_required_for_write_create_and_rename(self):
        readonly = OSError(errno.EROFS, 'not emitted')
        with patch('teetime_artifact_workspace.os.open', side_effect=readonly), \
             patch('teetime_artifact_workspace.os.mkdir', side_effect=readonly), \
             patch('teetime_artifact_workspace.os.rename', side_effect=OSError(errno.EBUSY, 'not emitted')):
            self.assertEqual(require_readonly_workspace('/workspace'),
                             {'write':'EROFS','create':'EROFS','rename':'EBUSY'})
        with patch('teetime_artifact_workspace.os.open', side_effect=PermissionError(errno.EACCES, 'private')):
            with self.assertRaisesRegex(ValueError, 'write denial not verified'):
                require_readonly_workspace('/workspace')

    def test_type_metadata_and_inspection_failures_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['.agents', '.codex']: (root/name).mkdir()
            before = self.snapshot(root); uid = (root/'.agents').stat().st_uid
            changed = tuple((*row[:-1], row[-1]+1) for row in before)
            self.assertEqual(workspace_diagnostic(root, changed, uid)['category'], 'mask_metadata_changed')
            (root/'.agents').rmdir(); (root/'.agents').write_bytes(b'not a directory')
            self.assertEqual(workspace_diagnostic(root, before, uid)['category'], 'mask_type_changed')
            self.assertEqual(workspace_diagnostic(root/'absent', before, uid)['category'], 'inspection_failed')


if __name__ == '__main__': unittest.main()
