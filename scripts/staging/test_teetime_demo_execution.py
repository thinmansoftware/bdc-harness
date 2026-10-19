import hashlib
import json
import unittest

import test_teetime_demo_case as case_tests
from teetime_artifact_contract import canonical
from teetime_demo_execution import parse_demo_execution, task_input, DEMO_LIMITS
from teetime_materialization_frame import encode_frame


class DemoExecutionTests(unittest.TestCase):
    def setUp(self):
        fixture = case_tests.DemoCaseTests()
        fixture.setUp()
        self.prepared = fixture.prepare()
        self.value = {'version': 1, 'kind': 'supervised-demo-v1',
            'preparedBindingHash': 'sha256:'+'c'*64, 'image': 'sha256:'+'d'*64,
            'source': 'e'*40, 'baseSource': 'f'*40,
            'binding': {'runId': 'actual-run', 'nodeId': 'implement', 'attempt': 1,
                        'authorityHash': 'sha256:'+'a'*64, 'policyHash': 'sha256:'+'b'*64,
                        'baseManifestHash': self.prepared.manifest_hash},
            'preparedFrame': json.loads(encode_frame(self.prepared.files,
                expected_manifest_hash=self.prepared.manifest_hash, expected_tree=self.prepared.source_tree)),
            'originalTree': self.prepared.original_tree,
            'originalManifestHash': self.prepared.original_manifest_hash,
            'assetHashes': dict(self.prepared.asset_hashes),
            'prompt': 'Full reviewed prompt',
            'promptHash': hashlib.sha256(b'Full reviewed prompt').hexdigest(),
            'limits': dict(DEMO_LIMITS)}

    def parse(self):
        raw = canonical(self.value).encode()
        return parse_demo_execution(raw, hashlib.sha256(raw).hexdigest())

    def test_package_reconstructs_prepared_base_and_task_input(self):
        execution = self.parse()
        self.assertEqual(execution.prepared, self.prepared)
        packet = json.loads(task_input(execution))
        self.assertEqual(packet['runId'], 'actual-run')
        self.assertEqual(packet['policyHash'], 'b'*64)
        self.assertEqual(packet['prompt'], self.value['prompt'])
        before = task_input(execution)
        with self.assertRaises(TypeError): execution.binding['runId'] = 'changed'
        self.value['binding']['runId'] = 'changed-input'
        self.assertEqual(task_input(execution), before)
        raw = canonical(self.value).encode()
        with self.assertRaises(ValueError): parse_demo_execution(raw, '0'*64)

    def test_identity_content_inventory_and_limit_drift_fail_closed(self):
        original = canonical(self.value)
        for kind in ['asset', 'prompt', 'tree', 'inventory', 'limits', 'attempt']:
            self.value = json.loads(original)
            if kind == 'asset': self.value['assetHashes']['package.json'] = '0'*64
            elif kind == 'prompt': self.value['prompt'] += 'changed'
            elif kind == 'tree': self.value['originalTree'] = '0'*40
            elif kind == 'inventory': self.value['preparedFrame']['files'].pop()
            elif kind == 'limits': self.value['limits']['querySeconds'] = 900
            else: self.value['binding']['attempt'] = 2
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.parse()

    def test_duplicate_keys_and_escaped_wire_overflow_rejected(self):
        raw = canonical(self.value).encode().replace(b'"version":1', b'"version":1,"version":1', 1)
        with self.assertRaises(ValueError):
            parse_demo_execution(raw, hashlib.sha256(raw).hexdigest())
        self.value['prompt'] = '\n'*100000
        self.value['promptHash'] = hashlib.sha256(self.value['prompt'].encode()).hexdigest()
        with self.assertRaises(ValueError): self.parse()

    def test_successor_requires_exact_link_and_remains_immutable(self):
        self.value.update(version=2, kind='supervised-demo-v2')
        self.value['binding']['attempt'] = 2
        with self.assertRaises(ValueError): self.parse()
        self.value['predecessor'] = {
            'attemptId': 'ec3fd06e-5f27-4eda-9af1-2f759e4157ae',
            'completedAt': '2026-10-19T02:43:09.062Z', 'owner': 'teetime-auth-5eca42816a98',
            **{key: 'sha256:'+'1'*64 for key in ('rowHash','executionHash','resultHash','claimHash')}}
        execution = self.parse()
        self.assertEqual(execution.binding['attempt'], 2)
        with self.assertRaises(TypeError): execution.predecessor['owner'] = 'changed'
        original = canonical(self.value)
        for kind in ['attempt', 'owner', 'rowHash', 'extra', 'version']:
            self.value = json.loads(original)
            if kind == 'attempt': self.value['binding']['attempt'] = 1
            elif kind == 'owner': self.value['predecessor']['owner'] = 'foreign'
            elif kind == 'rowHash': self.value['predecessor']['rowHash'] = '0'*64
            elif kind == 'extra': self.value['predecessor']['ignored'] = True
            else: self.value['version'] = 1
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.parse()


if __name__ == '__main__': unittest.main()
