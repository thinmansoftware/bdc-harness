from collections import Counter
import copy
import json
import unittest
from unittest.mock import patch
import teetime_connect_proxy as proxy
import test_teetime_minimal_worker as fixtures
from teetime_minimal_protocol import validate_minimal_operator_record


class OperatorRecordTests(unittest.TestCase):
    def record(self, mode='success', version=1):
        worker, _ = fixtures.MinimalWorkerTests().execute(mode)
        if version == 2:
            # Synthetic fixtures only, never a transformed historical receipt.
            worker['version'] = 2
            worker['taskReceipt']['version'] = 2
            if worker['taskReceipt']['failure'] is not None:
                worker['taskReceipt']['failure']['sdkEvidence'] = None
        with patch.multiple(proxy, outcomes=Counter(), parser_reasons=Counter(),
                non_parser_reasons=Counter(), request_line_reasons=Counter(), process_bytes=0, active=0, diagnostic_invalid=False):
            metrics = proxy.build_proxy_receipt(True) if version == 1 else proxy.build_proxy_receipt_v2()
        return {'owner': 'teetime-auth-'+'c'*12, 'task': 'minimal-diagnostic',
            'diagnosticSourceSha': fixtures.SOURCE, 'originalAuthUnchanged': True,
            'result': {'passed': worker['passed'], 'credentialReceived': True,
                       'cleanupVerified': True, 'proxyMetricsVerified': True,
                       'workerExitCode': 0 if worker['passed'] else 1, 'workerResult': worker},
            'proxyMetrics': metrics}

    def parse(self, value, code, version=1):
        return validate_minimal_operator_record(json.dumps(value).encode('ascii'), code,
            expected_source=fixtures.SOURCE, receipt_version=version)

    def test_success_and_validated_failure_keep_exact_data(self):
        for version in [1, 2]:
            for mode, code in [('success', 0), ('failed', 1)]:
                value = self.record(mode, version)
                self.assertEqual(self.parse(value, code, version), value)
                self.assertNotIn('PRIVATE', json.dumps(value))

    def test_nullable_failure_remains_unknown_and_nested_pass_does_not_make_outer_success(self):
        value = self.record()
        value['result'].update(passed=False, credentialReceived=False, proxyMetricsVerified=False,
                               workerExitCode=None, workerResult=None)
        value['proxyMetrics'] = None
        self.assertEqual(self.parse(value, 1), value)
        self.assertIsNone(value['result']['workerExitCode'])
        value = self.record(); value['result'].update(passed=False, cleanupVerified=False)
        self.assertTrue(self.parse(value, 1)['result']['workerResult']['passed'])
        self.assertFalse(self.parse(value, 1)['result']['passed'])

    def test_flags_types_exits_versions_and_private_keys_reject(self):
        baseline = self.record()
        for code in [1, True, False, None, -1, 2]:
            with self.assertRaises(ValueError): self.parse(baseline, code)
        for changes in [{'workerExitCode': False}, {'workerExitCode': None}, {'workerResult': None},
                        {'credentialReceived': False}, {'proxyMetricsVerified': False}, {'passed': False},
                        {'passed': 1}, {'privateMessage': 'PRIVATE'}]:
            value = copy.deepcopy(baseline); value['result'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.parse(value, 0)
        for changes in [{'originalAuthUnchanged': False}, {'originalAuthUnchanged': 1},
                        {'diagnosticSourceSha': 'e'*40}, {'private': 'PRIVATE'}, {'proxyMetrics': None}]:
            value = copy.deepcopy(baseline); value.update(changes)
            with self.assertRaises(ValueError): self.parse(value, 0)
        with self.assertRaises(ValueError): self.parse(baseline, 0, 2)
        with self.assertRaises(ValueError): self.parse(self.record(version=2), 0, 1)
        for version in [True, 0, 3, None]:
            with self.assertRaises(ValueError): self.parse(baseline, 0, version)
        raw = json.dumps(baseline).encode('ascii')
        for bad in [raw.replace(b'"task": "minimal-diagnostic"', b'"task":"minimal-diagnostic","task":"minimal-diagnostic"'), b'x'*32769]:
            with self.assertRaises(ValueError): validate_minimal_operator_record(bad, 0,
                expected_source=fixtures.SOURCE, receipt_version=1)


if __name__ == '__main__': unittest.main()
