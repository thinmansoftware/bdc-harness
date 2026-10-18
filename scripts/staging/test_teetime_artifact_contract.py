"""Pure strict source-data contract; no filesystem or model access."""
import hashlib
import json
import unittest

from teetime_snapshot import SnapshotFile, snapshot_manifest
from teetime_artifact_contract import parse_artifact


class ArtifactContractTests(unittest.TestCase):
    def setUp(self):
        self.base = (SnapshotFile('README.md', '100644', b'base\n'),
                     SnapshotFile('keep.bin', '100644', b'\x00\xff'))
        self.binding = {'runId': 'run-1', 'nodeId': 'implement', 'attempt': 1,
            'authorityHash': 'sha256:'+'a'*64, 'policyHash': 'sha256:'+'b'*64,
            'baseManifestHash': hashlib.sha256(snapshot_manifest(self.base).encode()).hexdigest()}
        self.allowed = {'index.html': ('100644',), 'README.md': ('100644',),
                        'scripts/check.sh': ('100644', '100755')}
        self.write = {'action': 'write', 'path': 'index.html', 'baseHash': None,
                      'mode': '100644', 'content': '<h1>SIMULATED</h1>\n'}

    def raw(self, ops=None, binding=None):
        return json.dumps({'version': 1, 'binding': binding or self.binding,
                           'operations': ops if ops is not None else [self.write]},
                          separators=(',', ':'), ensure_ascii=True).encode('ascii')

    def parse(self, raw, **changes):
        return parse_artifact(raw, base_files=changes.get('base_files', self.base),
            expected_binding=changes.get('expected_binding', self.binding),
            allowed_paths=changes.get('allowed_paths', self.allowed))

    def test_adds_file_and_preserves_all_unmentioned_binary_base_bytes(self):
        candidate = self.parse(self.raw())
        self.assertEqual([f.path for f in candidate.files], ['README.md', 'index.html', 'keep.bin'])
        self.assertEqual(candidate.files[2].content, b'\x00\xff')
        self.assertEqual(candidate.manifest_hash, hashlib.sha256(candidate.manifest.encode()).hexdigest())
        self.assertEqual(len(candidate.source_tree), 40)
        self.assertEqual(candidate, self.parse(self.raw()))
        with self.assertRaises(Exception):
            candidate.files = ()

    def test_explicit_write_delete_and_executable_mode(self):
        old_hash = hashlib.sha256(self.base[0].content).hexdigest()
        ops = [{'action': 'delete', 'path': 'README.md', 'baseHash': old_hash},
               {'action': 'write', 'path': 'scripts/check.sh', 'baseHash': None,
                'mode': '100755', 'content': 'exit 0\n'}]
        candidate = self.parse(self.raw(ops))
        self.assertEqual([f.path for f in candidate.files], ['keep.bin', 'scripts/check.sh'])
        self.assertEqual(candidate.files[1].git_mode, '100755')

    def test_rejects_wrong_echoed_or_trusted_base_binding(self):
        for key, value in [('runId', 'foreign'), ('attempt', 2), ('authorityHash', 'sha256:'+'c'*64),
                           ('policyHash', 'sha256:'+'d'*64), ('baseManifestHash', 'e'*64)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.parse(self.raw(binding={**self.binding, key: value}))
        changed_base = (SnapshotFile('README.md', '100644', b'changed'), self.base[1])
        with self.assertRaises(ValueError):
            self.parse(self.raw(), base_files=changed_base)

    def test_rejects_duplicates_at_every_json_object_level(self):
        raw = self.raw()
        bad = [raw.replace(b'"version":1', b'"version":1,"version":1'),
               raw.replace(b'"runId":"run-1"', b'"runId":"run-1","runId":"run-1"'),
               raw.replace(b'"action":"write"', b'"action":"write","action":"write"')]
        for data in bad:
            with self.subTest(raw=data), self.assertRaises(ValueError):
                self.parse(data)

    def test_rejects_malformed_utf8_fences_trailing_payload_depth_and_byte_bound(self):
        for bad in [b'\xff', b'\xef\xbb\xbf'+self.raw(), b'```json\n'+self.raw()+b'\n```',
                    self.raw()+b'{}', b'['*20+b'0'+b']'*20, b' '*65537]:
            with self.subTest(length=len(bad)), self.assertRaises(ValueError):
                self.parse(bad)

    def test_rejects_omitted_extra_and_wrong_type_schema_fields(self):
        value = json.loads(self.raw())
        bad = [{**value, 'version': True}, {**value, 'extra': 'not accepted'},
               {**value, 'operations': []}, {**value, 'operations': 'wrong'},
               {**value, 'binding': {**self.binding, 'attempt': True}}]
        for changed in bad:
            with self.subTest(value=changed), self.assertRaises(ValueError):
                self.parse(json.dumps(changed).encode())
        for changed in [{**self.write, 'extra': 1}, {key: item for key, item in self.write.items() if key != 'baseHash'}]:
            with self.assertRaises(ValueError):
                self.parse(self.raw([changed]))

    def test_rejects_paths_modes_unicode_nul_and_scope_expansion(self):
        for path in ['../outside', '.git/config', '.env', 'CON', 'unknown.html']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.parse(self.raw([{**self.write, 'path': path}]))
        for change in [{'mode': '100755'}, {'mode': '120000'}, {'content': '\u2603'},
                       {'content': '\x00'}, {'content': '\ud800'}, {'mode': {}}, {'content': []}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.parse(self.raw([{**self.write, **change}]))

    def test_rejects_duplicate_operations_stale_hash_and_absent_delete(self):
        old_hash = hashlib.sha256(self.base[0].content).hexdigest()
        bad = [[self.write, self.write],
               [{'action': 'delete', 'path': 'index.html', 'baseHash': 'a'*64}],
               [{**self.write, 'path': 'README.md'}],
               [{**self.write, 'path': 'README.md', 'baseHash': 'a'*64}],
               [{**self.write, 'baseHash': old_hash}]]
        for ops in bad:
            with self.subTest(ops=ops), self.assertRaises(ValueError):
                self.parse(self.raw(ops))

    def test_detects_candidate_file_directory_and_case_conflicts(self):
        for path in ['keep.bin/child', 'readme.md']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.parse(self.raw([{**self.write, 'path': path}]), allowed_paths={path: ('100644',)})

    def test_rejects_no_effective_change_and_operation_count_bound(self):
        unchanged = {'action': 'write', 'path': 'README.md', 'baseHash': hashlib.sha256(b'base\n').hexdigest(),
                     'mode': '100644', 'content': 'base\n'}
        for ops in [[unchanged], [self.write]*33]:
            with self.assertRaises(ValueError):
                self.parse(self.raw(ops))


if __name__ == '__main__':
    unittest.main()
