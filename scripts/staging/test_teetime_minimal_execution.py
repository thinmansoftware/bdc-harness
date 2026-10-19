"""Pure diagnostic packet/admission identity tests; no source or account mutation."""
import copy
from dataclasses import FrozenInstanceError
import hashlib
import json
import unittest
from teetime_artifact_contract import canonical
from teetime_minimal_protocol import ALL_PATHS
from teetime_minimal_execution import (MINIMAL_LIMITS, parse_minimal_execution,
    minimal_admission_hash, validate_minimal_carrier)


class MinimalExecutionTests(unittest.TestCase):
    def setUp(self):
        hashes = {path: '1'*64 for path in ALL_PATHS}
        self.value = {'version': 1, 'kind': 'teetime-minimal-execution',
            'repository': 'thinmansoftware/whats-that-tee-time', 'workflow': 'bdc-teetime-supervised-walkthrough',
            'woId': 'WO-TEETIME-SIMULATED-WALKTHROUGH-01', 'runId': 'a'*32,
            'nodeId': 'diagnose-transport', 'attempt': 1, 'preparedBindingHash': 'sha256:'+'2'*64,
            'authorityHash': 'sha256:'+'3'*64, 'runPolicyHash': 'sha256:'+'4'*64,
            'providerPolicyHash': 'sha256:'+'1'*64, 'provider': 'codex-native-strict', 'model': 'gpt-5.6-sol',
            'source': 'b'*40, 'baseSource': 'c'*40, 'image': 'sha256:'+'5'*64,
            'operatorInputHash': '6'*64, 'selectedHashes': hashes, 'limits': dict(MINIMAL_LIMITS),
            'predecessors': [{'attemptId': f'00000000-0000-0000-0000-{index:012d}',
                'completedAt': f'2026-10-19T0{index}:00:00.000Z', 'owner': f'teetime-auth-{index:012x}',
                **{key: 'sha256:'+str(index)*64 for key in ['rowHash','executionHash','resultHash','claimHash','manifestHash','lockHash']}}
                for index in range(1,5)]}

    def parse(self, value=None):
        raw = canonical(self.value if value is None else value).encode('ascii')
        return parse_minimal_execution(raw, hashlib.sha256(raw).hexdigest())

    def test_small_fixed_diagnostic_packet_is_not_product_execution_or_authority(self):
        value = self.parse()
        self.assertEqual(value.run_id, 'a'*32); self.assertEqual(value.source, 'b'*40)
        self.assertEqual(len(value.predecessors), 4)
        self.assertEqual(value.run_policy_hash, 'sha256:'+'4'*64)
        self.assertEqual(value.provider_policy_hash, 'sha256:'+'1'*64)
        self.value['selectedHashes'][ALL_PATHS[0]] = 'f'*64
        self.assertEqual(value.selected_hashes[ALL_PATHS[0]], '1'*64)
        with self.assertRaises(TypeError): value.selected_hashes[ALL_PATHS[0]] = 'f'*64
        with self.assertRaises(TypeError): value.predecessors[0]['owner'] = 'PRIVATE'
        with self.assertRaises(FrozenInstanceError): value.source = 'f'*40

    def test_closed_fields_histories_policy_meanings_and_fixed_budgets(self):
        cases = []
        for key, bad in [('version', True), ('nodeId', 'implement'), ('attempt', 5), ('provider', 'other'),
                         ('model', 'other'), ('kind', 'supervised-demo-v4'), ('prompt', 'PRIVATE'),
                         ('policyHash', 'sha256:'+'1'*64), ('providerPolicyHash', 'sha256:'+'9'*64)]:
            value = copy.deepcopy(self.value); value[key] = bad; cases.append(value)
        for change in ['missing-helper', 'extra-helper', 'bad-limit', 'short-history', 'duplicate-history', 'unordered-history']:
            value = copy.deepcopy(self.value)
            if change == 'missing-helper': value['selectedHashes'].pop(ALL_PATHS[0])
            if change == 'extra-helper': value['selectedHashes']['PRIVATE'] = '1'*64
            if change == 'bad-limit': value['limits']['sshTransportSeconds'] += 1
            if change == 'short-history': value['predecessors'].pop()
            if change == 'duplicate-history': value['predecessors'][1] = value['predecessors'][0]
            if change == 'unordered-history': value['predecessors'].reverse()
            cases.append(value)
        for index, value in enumerate(cases):
            with self.subTest(case=index), self.assertRaises(ValueError): self.parse(value)

    def test_raw_json_hash_duplicate_and_canonical_bounds(self):
        good = canonical(self.value).encode()
        for raw, expected in [(good, '0'*64), (b'x'*32769, '0'*64),
                (good.replace(b'"version":1', b'"version":1,"version":1'), None),
                (json.dumps(self.value).encode(), None), (b'\xff', None)]:
            with self.assertRaises(ValueError):
                parse_minimal_execution(raw, expected or hashlib.sha256(raw).hexdigest())

    def test_external_inventory_has_distinct_domain_hash_and_review_carrier(self):
        execution = self.parse()
        expected_object = {'version': 1, 'kind': 'teetime-minimal-admission',
            'executionHash': execution.package_hash, 'installedManifestHash': '7'*64,
            'operatorInputHash': execution.operator_input_hash, 'source': execution.source}
        digest = minimal_admission_hash(execution, '7'*64)
        self.assertEqual(digest, hashlib.sha256(canonical(expected_object).encode()).hexdigest())
        self.assertNotEqual(digest, minimal_admission_hash(execution, '8'*64))
        carrier = {**expected_object, 'kind': 'teetime-minimal-admission-review', 'admissionHash': digest}
        validate_minimal_carrier(canonical(carrier).encode(), execution, '7'*64)
        for field, bad in [('installedManifestHash', '8'*64), ('admissionHash', '9'*64), ('extra', 'PRIVATE')]:
            value = {**carrier, field: bad}
            with self.assertRaises(ValueError): validate_minimal_carrier(canonical(value).encode(), execution, '7'*64)


if __name__ == '__main__': unittest.main()
