"""Pure join checks. SDK outcome/custody checks belong to the trusted controller."""
from dataclasses import FrozenInstanceError
import hashlib
import json
import unittest

from teetime_artifact_materialization import prepare_materialization
from teetime_materialization_frame import decode_frame, encode_frame
from teetime_snapshot import SnapshotFile, snapshot_manifest
from teetime_git_objects import build_git_objects


class JoinTests(unittest.TestCase):
    def setUp(self):
        self.base = (SnapshotFile('data.bin', '100644', b'\x00\xffbinary'),
                     SnapshotFile('src/run.sh', '100755', b'#!/bin/sh\nexit 0\n'))
        self.binding = {'runId': 'joined-fixture-run', 'nodeId': 'implement', 'attempt': 1,
            'authorityHash': 'sha256:'+'a'*64, 'policyHash': 'sha256:'+'b'*64,
            'baseManifestHash': hashlib.sha256(snapshot_manifest(self.base).encode()).hexdigest()}
        self.value = {'version': 1, 'binding': dict(self.binding), 'operations': [
            {'action': 'write', 'path': 'index.html', 'baseHash': None, 'mode': '100644',
             'content': '<p>synthetic-artifact-ready</p>\n'}]}
        self.allowed = {'index.html': ('100644',)}

    def raw(self):
        return json.dumps(self.value, sort_keys=True, separators=(',', ':')).encode()

    def prepare(self, raw=None):
        return prepare_materialization(self.raw() if raw is None else raw,
            base_files=self.base, expected_binding=self.binding, allowed_paths=self.allowed)

    def decoded(self, prepared):
        return decode_frame(prepared.frame, expected_manifest_hash=prepared.manifest_hash,
                            expected_tree=prepared.source_tree)

    def test_exact_three_file_join_preserves_trusted_binary_and_executable_mode(self):
        prepared = self.prepare()
        expected = (self.base[0], SnapshotFile('index.html', '100644', b'<p>synthetic-artifact-ready</p>\n'), self.base[1])
        self.assertEqual(self.decoded(prepared), expected)
        self.assertEqual(prepared.raw_artifact_hash, hashlib.sha256(self.raw()).hexdigest())
        self.assertEqual(prepared.manifest_hash, hashlib.sha256(snapshot_manifest(expected).encode()).hexdigest())
        self.assertEqual(prepared.source_tree, build_git_objects(expected, expected_format='sha1').root_tree)
        binding_bytes = json.dumps(self.binding, sort_keys=True, separators=(',', ':')).encode()
        self.assertEqual(prepared.binding_hash, hashlib.sha256(binding_bytes).hexdigest())
        with self.assertRaises(FrozenInstanceError):
            prepared.frame = b'forged'

    def test_every_foreign_binding_field_rejected(self):
        changes = {'runId': 'foreign-run', 'nodeId': 'review', 'attempt': 2,
                   'authorityHash': 'sha256:'+'c'*64, 'policyHash': 'sha256:'+'d'*64,
                   'baseManifestHash': 'e'*64}
        for key, value in changes.items():
            self.value['binding'] = {**self.binding, key: value}
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    self.prepare()

    def test_extra_operation_or_path_rejected(self):
        self.value['operations'].append({**self.value['operations'][0], 'path': 'unexpected.txt'})
        with self.assertRaises(ValueError):
            self.prepare()
        self.value['operations'][1]['path'] = 'index.html'
        with self.assertRaises(ValueError):
            self.prepare()

    def test_malformed_or_concatenated_artifacts_rejected(self):
        raw = self.raw()
        for bad in [b'{}', b'null', raw+raw, b'```json\n'+raw+b'\n```',
                    raw.replace(b'"version":1', b'"version":1,"version":1')]:
            with self.assertRaises(ValueError):
                self.prepare(bad)
        with self.assertRaises(ValueError):
            prepare_materialization(None, base_files=self.base, expected_binding=self.binding, allowed_paths=self.allowed)

    def test_transport_overflow_from_trusted_base_rejected(self):
        self.base = (SnapshotFile('data.bin', '100644', b'x'*50000), self.base[1])
        self.binding['baseManifestHash'] = hashlib.sha256(snapshot_manifest(self.base).encode()).hexdigest()
        self.value['binding'] = dict(self.binding)
        with self.assertRaisesRegex(ValueError, 'transport'):
            self.prepare()

    def test_substituted_frame_or_candidate_bytes_fail_original_identity(self):
        prepared = self.prepare()
        changed = tuple(SnapshotFile(file.path, file.git_mode, b'forged') if file.path == 'index.html' else file
                        for file in self.decoded(prepared))
        digest = hashlib.sha256(snapshot_manifest(changed).encode()).hexdigest()
        tree = build_git_objects(changed, expected_format='sha1').root_tree
        substituted = encode_frame(changed, expected_manifest_hash=digest, expected_tree=tree)
        with self.assertRaises(ValueError):
            decode_frame(substituted, expected_manifest_hash=prepared.manifest_hash, expected_tree=prepared.source_tree)
        with self.assertRaises(ValueError):
            encode_frame(changed, expected_manifest_hash=prepared.manifest_hash, expected_tree=prepared.source_tree)


if __name__ == '__main__':
    unittest.main()
