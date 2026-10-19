"""Offline diagnostic handshake, closure and outer-failure evidence tests."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from teetime_minimal_protocol import (ALL_PATHS, IMAGE_PATHS, diagnostic_hashes,
    diagnostic_identity, validate_diagnostic_selector, validate_diagnostic_ready,
    validate_diagnostic_report, sanitize_cleanup_errors)
from teetime_auth_artifact_protocol import validate_ready as legacy_ready
from teetime_auth_artifact_protocol import validate_report as legacy_report
from teetime_connect_proxy import build_proxy_receipt
import teetime_connect_proxy as proxy
from unittest.mock import patch
import test_teetime_minimal_worker as fixtures
NONCE, SOURCE = fixtures.NONCE, fixtures.SOURCE


class MinimalProtocolTests(unittest.TestCase):
    def setUp(self):
        self.base = 'c'*40; self.image = 'sha256:'+'d'*64
        self.hashes = {name: hashlib.sha256(name.encode()).hexdigest() for name in ALL_PATHS}
        identity = diagnostic_identity(NONCE, self.image, self.base, SOURCE, self.hashes)
        self.ready = {'type': 'READY', 'nonce': NONCE, 'image': self.image, 'sourceSha': self.base,
            'owner': 'teetime-auth-'+'e'*12, 'manifestSha256': 'f'*64, 'workerId': '1'*64,
            'gatewayId': '2'*64, 'hashes': self.hashes, 'task': 'minimal-diagnostic',
            'diagnosticSourceSha': SOURCE, 'diagnosticContractHash': identity}
        worker, _ = fixtures.MinimalWorkerTests().execute()
        with patch.multiple(proxy, outcomes={}, parser_reasons={}, non_parser_reasons={},
                            active=0, process_bytes=0, diagnostic_invalid=False):
            metrics = build_proxy_receipt(True)
        self.report = {'type': 'RESULT', 'nonce': NONCE, 'owner': self.ready['owner'],
            'task': 'minimal-diagnostic', 'diagnosticSourceSha': SOURCE,
            'diagnosticContractHash': identity, 'cleanupErrors': [], 'receiptDirectory': 'owned-receipt',
            'proxyMetrics': metrics, 'result': {'passed': True, 'cleanupVerified': True,
            'credentialReceived': True, 'proxyMetricsVerified': True, 'workerExitCode': 0, 'workerResult': worker}}

    def ready_check(self, value):
        return validate_diagnostic_ready(value, nonce=NONCE, image=self.image,
            base_source=self.base, source=SOURCE, hashes=self.hashes)

    def check(self, value=None, code=0):
        return validate_diagnostic_report(json.dumps(self.report if value is None else value).encode(), code, ready=self.ready)

    def test_exact_selected_closure_and_tamper_rejection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ALL_PATHS:
                target = root/name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(name.encode())
            manifest = {'source': SOURCE, 'baseSource': self.base, 'baseImage': self.image, 'fileHashes': self.hashes}
            (root/'source-manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(diagnostic_hashes(root/'scripts/staging', SOURCE, self.base), self.hashes)
            self.assertTrue(set(IMAGE_PATHS).issubset(self.hashes))
            manifest['fileHashes'] = {**self.hashes, 'PRIVATE-UNKNOWN': 'a'*64}
            (root/'source-manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): diagnostic_hashes(root/'scripts/staging', SOURCE, self.base)
            manifest['fileHashes'] = self.hashes
            (root/'source-manifest.json').write_text(json.dumps(manifest))
            (root/'scripts/staging/teetime_minimal_worker.py').write_bytes(b'PRIVATE-CHANGED')
            with self.assertRaises(ValueError): diagnostic_hashes(root/'scripts/staging', SOURCE, self.base)

    def test_ready_identity_and_selector_cannot_mix_with_legacy(self):
        validate_diagnostic_selector('minimal-diagnostic', SOURCE, None, None)
        for args in [('artifact', SOURCE, None, None), ('minimal-diagnostic', SOURCE, SOURCE, None),
                     ('minimal-diagnostic', SOURCE, None, 'a'*64), ('minimal-diagnostic', None, None, None)]:
            with self.assertRaises(ValueError): validate_diagnostic_selector(*args)
        self.ready_check(self.ready)
        for key, bad in [('hashes', {}), ('task', 'artifact'), ('nonce', '0'*32),
                         ('diagnosticSourceSha', '0'*40), ('diagnosticContractHash', '0'*64), ('extra', 0)]:
            with self.assertRaises(ValueError): self.ready_check({**self.ready, key: bad})
        with self.assertRaises(ValueError):
            legacy_ready(self.ready, nonce=NONCE, image=self.image, base_source=self.base, source=SOURCE, hashes=self.hashes)
        with self.assertRaises(ValueError): legacy_report(self.report, 0, ready=self.ready, policy_hash='a'*64)

    def test_valid_nested_evidence_survives_outer_failure_without_success(self):
        self.assertEqual(self.check(), self.report)
        failed = copy.deepcopy(self.report); failed['result'].update(passed=False, proxyMetricsVerified=False)
        failed['proxyMetrics'] = None
        self.assertTrue(self.check(failed, 1)['result']['workerResult']['passed'])
        for field in ['cleanupVerified', 'credentialReceived', 'proxyMetricsVerified']:
            invalid = copy.deepcopy(self.report); invalid['result'][field] = False
            with self.assertRaises(ValueError): self.check(invalid)
        for code in [1, True, None]:
            with self.assertRaises(ValueError): self.check(code=code)
        raw = json.dumps(self.report).encode().replace(b'"type": "RESULT"', b'"type":"RESULT","type":"RESULT"')
        with self.assertRaises(ValueError): validate_diagnostic_report(raw, 0, ready=self.ready)

    def test_missing_worker_receipt_is_unknown_and_closed_cleanup_errors(self):
        failed = copy.deepcopy(self.report)
        failed['result'].update(passed=False, workerResult=None, workerExitCode=None)
        self.assertIsNone(self.check(failed, 1)['result']['workerResult'])
        errors = sanitize_cleanup_errors([{'kind': 'capture', 'id': None, 'failure': 'PRIVATE-ERROR'}])
        self.assertEqual(errors, [{'kind': 'capture', 'id': None, 'failure': 'UnknownFailure'}])
        failed['cleanupErrors'] = errors; failed['result']['cleanupVerified'] = False
        self.check(failed, 1)
        failed['cleanupErrors'][0]['failure'] = 'PRIVATE'
        with self.assertRaises(ValueError): self.check(failed, 1)
        with self.assertRaises(ValueError): sanitize_cleanup_errors(errors*6)


if __name__ == '__main__': unittest.main()
