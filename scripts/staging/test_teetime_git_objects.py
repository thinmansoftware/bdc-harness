"""Cross-check pure candidate objects against isolated trusted Git plumbing."""
import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

from teetime_snapshot import read_snapshot
from teetime_git_objects import build_git_objects


def snapshot(items):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path, content, mode in items:
            entry = tarfile.TarInfo(path)
            entry.mode = mode
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
    return read_snapshot(output.getvalue(), [item[0] for item in items])


class GitObjectTests(unittest.TestCase):
    def test_empty_tree_has_canonical_identity(self):
        result = build_git_objects(snapshot([]), expected_format='sha1')
        self.assertEqual(result.root_tree, '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
        self.assertEqual(len(result.objects), 1)
        self.assertEqual(result.objects[0].kind, 'tree')
        self.assertEqual(result.objects[0].payload, b'')

    def test_directory_ordering_and_executable_binary_contents(self):
        files = snapshot([('foo/file', b'\x00\xff\r\n', 0o755),
                          ('foo.bar', b'text\n', 0o644)])
        result = build_git_objects(files, expected_format='sha1')
        objects = {item.oid: item for item in result.objects}
        root = objects[result.root_tree].payload
        self.assertTrue(root.startswith(b'100644 foo.bar\0'))
        self.assertIn(b'40000 foo\0', root)
        self.assertTrue(any(item.payload.startswith(b'100755 file\0')
                            for item in result.objects if item.kind == 'tree'))
        self.assertTrue(any(item.payload == b'\x00\xff\r\n'
                            for item in result.objects if item.kind == 'blob'))

    def test_order_independent_and_duplicate_blob_deduplication(self):
        items = [('z/a', b'same', 0o644), ('a', b'same', 0o755)]
        first = build_git_objects(snapshot(items), expected_format='sha1')
        second = build_git_objects(snapshot(list(reversed(items))), expected_format='sha1')
        self.assertEqual(first, second)
        self.assertEqual(sum(item.kind == 'blob' for item in first.objects), 1)
        for item in first.objects:
            encoded = item.kind.encode('ascii')+b' '+str(len(item.payload)).encode('ascii')+b'\0'+item.payload
            self.assertEqual(item.oid, hashlib.sha1(encoded).hexdigest())

    def test_complete_candidate_does_not_restore_deleted_base_files(self):
        base = build_git_objects(snapshot([('keep', b'k', 0o644),
                                           ('deleted', b'd', 0o644)]), expected_format='sha1')
        candidate = build_git_objects(snapshot([('keep', b'k', 0o644),
                                                ('new', b'n', 0o644)]), expected_format='sha1')
        self.assertNotEqual(base.root_tree, candidate.root_tree)
        payload = next(item.payload for item in candidate.objects if item.oid == candidate.root_tree)
        self.assertNotIn(b' deleted\0', payload)
        self.assertIn(b' new\0', payload)

    def test_rejects_other_or_missing_object_format(self):
        for object_format in ['sha256', '', None, 'SHA1']:
            with self.subTest(format=object_format), self.assertRaises(ValueError):
                build_git_objects(snapshot([]), expected_format=object_format)
        with self.assertRaises(TypeError):
            build_git_objects(snapshot([]))

    def test_rejects_mutable_or_malformed_records(self):
        from teetime_snapshot import SnapshotFile
        with self.assertRaises(ValueError):
            build_git_objects(list(snapshot([])), expected_format='sha1')
        for files in [(SnapshotFile('bad', '120000', b'x'),),
                      (SnapshotFile('a', '100644', bytearray(b'x')),),
                      (SnapshotFile('../escape', '100644', b'x'),),
                      (SnapshotFile('a', '100644', b'x'), SnapshotFile('a/b', '100644', b'y')),
                      (SnapshotFile('A/x', '100644', b'x'), SnapshotFile('a/y', '100644', b'y'))]:
            with self.subTest(files=files), self.assertRaises(ValueError):
                build_git_objects(files, expected_format='sha1')

    def test_rejects_snapshot_input_bounds(self):
        from teetime_snapshot import MAX_FILE, MAX_FILES, SnapshotFile
        for files in [tuple(SnapshotFile('f'+str(i), '100644', b'') for i in range(MAX_FILES+1)),
                      (SnapshotFile('large', '100644', b'x'*(MAX_FILE+1)),),
                      tuple(SnapshotFile('f'+str(i), '100644', b'x'*MAX_FILE) for i in range(9))]:
            with self.subTest(count=len(files)), self.assertRaises(ValueError):
                build_git_objects(files, expected_format='sha1')

    def test_trusted_git_plumbing_matches_all_objects_and_complete_candidate(self):
        git = shutil.which('git')
        self.assertIsNotNone(git, 'trusted Git plumbing is required; do not skip this check')
        fixtures = [[], [('foo/file', b'\x00\xff\r\n', 0o755), ('foo.bar', b'text\n', 0o644)],
                    [('a/b/c', b'nested', 0o644), ('same', b'nested', 0o755)],
                    [('keep', b'k', 0o644), ('deleted', b'd', 0o644)],
                    [('keep', b'k', 0o644), ('new', b'n', 0o644)]]
        with tempfile.TemporaryDirectory(prefix='teetime-trusted-git-') as folder:
            root = Path(folder)
            template = root/'empty-template'
            hooks = root/'empty-hooks'
            template.mkdir()
            hooks.mkdir()
            env = {key: value for key, value in os.environ.items()
                   if key.upper() in ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']}
            env.update({'HOME': str(root), 'USERPROFILE': str(root),
                        'XDG_CONFIG_HOME': str(root/'empty-config'),
                        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                        'GIT_TERMINAL_PROMPT': '0'})
            def run(repo, *args, data=None):
                return subprocess.run([git, '--no-replace-objects', '-c', 'protocol.allow=never',
                    '-c', 'core.hooksPath='+str(hooks), '-c', 'core.attributesFile='+os.devnull,
                    '-c', 'core.autocrlf=false', '-C', str(repo), *args], input=data,
                    capture_output=True, check=True, timeout=10, env=env).stdout
            for index, items in enumerate(fixtures):
                with self.subTest(fixture=index):
                    repo = root/('repo-'+str(index))
                    run(root, 'init', '--bare', '--object-format=sha1', '--template='+str(template), str(repo))
                    files = snapshot(items)
                    result = build_git_objects(files, expected_format='sha1')
                    for item in result.objects:
                        oid = run(repo, 'hash-object', '-w', '-t', item.kind, '--stdin', data=item.payload).decode().strip()
                        self.assertEqual(oid, item.oid)
                    for file in files:
                        oid = run(repo, 'hash-object', '-w', '--stdin', data=file.content).decode().strip()
                        run(repo, 'update-index', '--add', '--cacheinfo', file.git_mode, oid, file.path)
                    self.assertEqual(run(repo, 'write-tree').decode().strip(), result.root_tree)
                    listing = run(repo, 'ls-tree', '-r', '-z', result.root_tree)
                    paths = [entry.split(b'\t', 1)[1].decode('ascii') for entry in listing.split(b'\0') if entry]
                    self.assertEqual(sorted(paths), sorted(file.path for file in files))


if __name__ == '__main__':
    unittest.main()
