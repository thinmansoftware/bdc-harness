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
            **{key: 'sha256:'+'1'*64 for key in ('rowHash','executionHash','resultHash','claimHash','manifestHash','lockHash')}}
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

    def third_package(self):
        self.value.update(version=3,kind='supervised-demo-v3')
        self.value['binding']['attempt']=3
        self.value['predecessors']=[{
            'attemptId':identifier,'completedAt':completed,'owner':owner,
            **{key:'sha256:'+digit*64 for key in
               ('rowHash','executionHash','resultHash','claimHash','manifestHash','lockHash')}}
            for identifier,completed,owner,digit in [
                ('ec3fd06e-5f27-4eda-9af1-2f759e4157ae','2026-10-19T02:43:09.062Z','teetime-auth-5eca42816a98','1'),
                ('2a99ad54-3b2b-45ae-a923-6c1a7073ac30','2026-10-19T03:27:36.872Z','teetime-auth-d2a4ae153136','2')]]

    def test_third_package_is_closed_ordered_and_immutable(self):
        self.third_package();execution=self.parse()
        self.assertIsNone(execution.predecessor)
        self.assertEqual(len(execution.predecessors),2)
        with self.assertRaises(TypeError):execution.predecessors[1]['owner']='changed'
        original=canonical(self.value)
        for kind in ['reversed','duplicate_id','duplicate_owner','extra','missing','legacy_field','version','attempt']:
            self.value=json.loads(original);entries=self.value['predecessors']
            if kind=='reversed':entries.reverse()
            elif kind=='duplicate_id':entries[1]['attemptId']=entries[0]['attemptId']
            elif kind=='duplicate_owner':entries[1]['owner']=entries[0]['owner']
            elif kind=='extra':entries.append(entries[1])
            elif kind=='missing':entries.pop()
            elif kind=='legacy_field':self.value['predecessor']=entries[0]
            elif kind=='version':self.value['version']=2
            else:self.value['binding']['attempt']=2
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.parse()

    def fourth_package(self):
        self.third_package()
        self.value.update(version=4,kind='supervised-demo-v4')
        self.value['binding']['attempt']=4
        self.value['predecessors'].append({
            'attemptId':'65380465-a8b3-462f-a114-11f941be8bf3',
            'completedAt':'2026-10-19T04:36:57.507Z','owner':'teetime-auth-558227ab727a',
            **{key:'sha256:'+'3'*64 for key in
               ('rowHash','executionHash','resultHash','claimHash','manifestHash','lockHash')}})

    def test_fourth_package_requires_exact_three_immutable_histories(self):
        self.fourth_package(); execution=self.parse()
        self.assertEqual(execution.binding['attempt'],4)
        self.assertEqual(len(execution.predecessors),3)
        with self.assertRaises(TypeError): execution.predecessors[2]['owner']='changed'
        original=canonical(self.value)
        for kind in ['reversed','duplicate_id','duplicate_owner','extra','missing','legacy_field','version5','wrong_kind','attempt']:
            self.value=json.loads(original); entries=self.value['predecessors']
            if kind=='reversed':entries.reverse()
            elif kind=='duplicate_id':entries[2]['attemptId']=entries[0]['attemptId']
            elif kind=='duplicate_owner':entries[2]['owner']=entries[0]['owner']
            elif kind=='extra':entries.append(entries[2])
            elif kind=='missing':entries.pop()
            elif kind=='legacy_field':self.value['predecessor']=entries[0]
            elif kind=='version5':self.value.update(version=5,kind='supervised-demo-v5')
            elif kind=='wrong_kind':self.value['kind']='supervised-demo-v3'
            else:self.value['binding']['attempt']=3
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.parse()


if __name__ == '__main__': unittest.main()
