import hashlib
import io
import json
import tarfile
import unittest
from teetime_snapshot import read_snapshot, snapshot_manifest, MAX_FILE


def archive(items, format=tarfile.USTAR_FORMAT):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=format) as tar:
        for path, content, mode, kind in items:
            item = tarfile.TarInfo(path)
            item.mode = mode
            item.type = kind
            item.size = len(content)
            if kind == tarfile.SYMTYPE:
                item.linkname = '/outside'
            tar.addfile(item, io.BytesIO(content))
    return output.getvalue()


class SnapshotTests(unittest.TestCase):
    def test_captures_added_files_and_executable_modes_without_extraction(self):
        raw = archive([('src/new.ts', b'export const ready = true;\n', 0o644, tarfile.REGTYPE),
                       ('scripts/check.sh', b'exit 0\n', 0o755, tarfile.REGTYPE)])
        files = read_snapshot(raw, ['src/new.ts', 'scripts/check.sh'])
        manifest = json.loads(snapshot_manifest(files))
        self.assertEqual([file.path for file in files], ['scripts/check.sh', 'src/new.ts'])
        self.assertEqual(files[0].git_mode, '100755')
        self.assertEqual(files[1].git_mode, '100644')
        self.assertEqual(manifest['files'][1]['sha256'], hashlib.sha256(files[1].content).hexdigest())

    def test_rejects_unapproved_files_even_if_gitignore_would_ignore_them(self):
        raw = archive([('ignored.tmp', b'content', 0o644, tarfile.REGTYPE)])
        with self.assertRaises(ValueError):
            read_snapshot(raw, ['src/new.ts'])

    def test_rejects_empty_and_incomplete_expected_inventory(self):
        empty = archive([])
        with self.assertRaises(ValueError):
            read_snapshot(empty, ['required.ts'])
        partial = archive([('first.ts', b'first', 0o644, tarfile.REGTYPE)])
        with self.assertRaises(ValueError):
            read_snapshot(partial, ['first.ts', 'missing.ts'])

    def test_rejects_traversal_reserved_names_metadata_and_credentials(self):
        for path in ['../escape', '/absolute', 'a/../escape', 'a//b', './relative',
                     'file:stream', 'AUX.txt', 'dir/NUL', 'trail.', '.git/config',
                     '.codex/config.toml', '.agents/instructions.md', '.env', '.env.local']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                read_snapshot(archive([(path, b'x', 0o644, tarfile.REGTYPE)]), [path])

    def test_rejects_duplicate_and_case_colliding_paths(self):
        for paths in [['a.ts', 'a.ts'], ['a.ts', 'A.ts'], ['Src/a.ts','src/b.ts'], ['a','a/b.ts']]:
            raw = archive([(path, b'x', 0o644, tarfile.REGTYPE) for path in paths])
            with self.assertRaises(ValueError):
                read_snapshot(raw, paths)

    def test_rejects_links_devices_fifos_and_extended_headers(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE, tarfile.XHDTYPE]:
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                read_snapshot(archive([('a.ts', b'', 0o644, kind)]), ['a.ts'])

    def test_rejects_checksum_damage_truncation_and_appended_payload(self):
        good = archive([('a.ts', b'content', 0o644, tarfile.REGTYPE)])
        damaged = bytearray(good); damaged[0] = ord('z')
        for raw in [bytes(damaged), good[:512], good[:-1], good+b'x'*512]:
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                read_snapshot(raw, ['a.ts'])

    def test_rejects_oversized_files_and_special_modes(self):
        for content, mode in [(b'x'*(MAX_FILE+1), 0o644), (b'x', 0o4755)]:
            with self.assertRaises(ValueError):
                read_snapshot(archive([('a.ts', content, mode, tarfile.REGTYPE)]), ['a.ts'])

    def test_manifest_is_canonical_and_changes_with_content(self):
        first = read_snapshot(archive([('a.ts', b'first', 0o644, tarfile.REGTYPE)]), ['a.ts'])
        second = read_snapshot(archive([('a.ts', b'second', 0o644, tarfile.REGTYPE)]), ['a.ts'])
        self.assertEqual(snapshot_manifest(first), snapshot_manifest(tuple(reversed(first))))
        self.assertNotEqual(snapshot_manifest(first), snapshot_manifest(second))


if __name__ == '__main__':
    unittest.main()
