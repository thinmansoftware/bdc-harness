import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from teetime_minimal_protocol import ALL_PATHS, IMAGE_PATHS
from teetime_minimal_v2_contract import V2_ALL_PATHS, V2_IMAGE_PATHS, verify_v2_closure


class V2ClosureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        hashes = {}
        for name in V2_ALL_PATHS:
            path = self.root/name; path.parent.mkdir(parents=True, exist_ok=True)
            data = ('fixture:'+name).encode('ascii'); path.write_bytes(data)
            hashes[name] = hashlib.sha256(data).hexdigest()
        self.manifest = {'version': 2, 'kind': 'teetime-minimal-source-v2',
                         'source': 'a'*40, 'baseSource': 'b'*40, 'fileHashes': hashes}
        self.raw = self.encode(self.manifest)
        # Freeze this independently of any subsequently supplied file/manifest bytes.
        self.expected = hashlib.sha256(self.raw).hexdigest()

    def encode(self, value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')

    def verify(self, raw=None):
        return verify_v2_closure(self.root, self.raw if raw is None else raw,
            expected_manifest_hash=self.expected, source='a'*40, base_source='b'*40)

    def test_separate_sets_include_new_dependency_and_do_not_change_v1(self):
        dependency = 'packages/providers/src/codex/sdk-failure-evidence.ts'
        self.assertNotIn(dependency, ALL_PATHS); self.assertNotIn(dependency, IMAGE_PATHS)
        self.assertIn(dependency, V2_ALL_PATHS); self.assertIn(dependency, V2_IMAGE_PATHS)
        verifier = 'scripts/staging/teetime_minimal_v2_contract.py'
        self.assertIn(verifier, V2_ALL_PATHS); self.assertNotIn(verifier, V2_IMAGE_PATHS)
        envelope = 'scripts/staging/teetime_minimal_pc_envelope.py'
        self.assertIn(envelope, V2_ALL_PATHS); self.assertNotIn(envelope, V2_IMAGE_PATHS)
        self.assertTrue(set(ALL_PATHS).issubset(V2_ALL_PATHS))
        self.assertEqual(self.verify(), self.manifest['fileHashes'])

    def test_missing_dependency_rejects(self):
        (self.root/'packages/providers/src/codex/sdk-failure-evidence.ts').unlink()
        with self.assertRaises((ValueError, FileNotFoundError)): self.verify()

    def test_substitution_and_matching_untrusted_manifest_cannot_replace_frozen_hash(self):
        name = 'packages/providers/src/codex/sdk-failure-evidence.ts'
        (self.root/name).write_bytes(b'substituted')
        with self.assertRaises(ValueError): self.verify()
        self.manifest['fileHashes'][name] = hashlib.sha256(b'substituted').hexdigest()
        with self.assertRaises(ValueError): self.verify(self.encode(self.manifest))

    def test_source_version_extra_and_missing_members_reject(self):
        for key, change in [('version', 1), ('source', 'c'*40), ('extra', True)]:
            value = {**self.manifest, key: change}
            with self.assertRaises(ValueError): self.verify(self.encode(value))
        self.manifest['fileHashes'].pop('packages/providers/src/codex/sdk-failure-evidence.ts')
        with self.assertRaises(ValueError): self.verify(self.encode(self.manifest))


if __name__ == '__main__': unittest.main()
