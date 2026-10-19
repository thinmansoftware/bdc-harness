"""Synthetic worker fixtures and argument-rejection subprocess; no account/network."""
import copy
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import teetime_minimal_worker as worker
from teetime_minimal_worker_result import validate_minimal_worker

NONCE = 'a'*32
SOURCE = 'b'*40


def success():
    return {'version': 1, 'kind': 'teetime-minimal-diagnostic', 'passed': True,
            'responseVerified': True, 'modelInvocations': 1, 'assistantCount': 1,
            'resultCount': 1, 'thinkingCount': 0, 'chunkCount': 2,
            'normalProviderEnd': True, 'providerIteratorClosed': True,
            'aborted': False, 'failure': None}


class MinimalWorkerTests(unittest.TestCase):
    def execute(self, mode='success'):
        with tempfile.TemporaryDirectory() as folder:
            auth = Path(folder)/'auth'; auth.write_bytes(b'PRIVATE-AUTH')
            calls = []
            class Auth:
                def lstat(self): return SimpleNamespace(st_mode=stat.S_IFREG|0o600, st_uid=1001, st_size=12)
                def read_bytes(self): return auth.read_bytes()
            class FixturePath:
                @staticmethod
                def cwd(): return '/workspace'
                def __init__(self, _path): pass
                def exists(self): return False
            def preflight():
                worker.base.PREFLIGHT_CHECKS = 5 if mode == 'preflight' else 6
                worker.base.AUTH_REJECTED = mode == 'preflight'
                if mode == 'preflight': raise ValueError('PRIVATE-REJECT')
            snapshots = [1, 2, 3] if mode == 'preflight_mutation' else [1, 1, 1]
            if mode == 'workspace': snapshots = [1, 1, 2]
            def capture(argv, timeout, **kwargs):
                calls.append(argv)
                self.assertEqual(argv, ['bun', '/app/scripts/staging/teetime-minimal-diagnostic-entry.ts'])
                self.assertEqual(timeout, 100); self.assertEqual(kwargs, {'include_exit_code': True})
                if mode == 'timeout': raise TimeoutError('PRIVATE-TIMEOUT')
                if mode == 'auth': auth.write_bytes(b'PRIVATE-CHANGED')
                if mode == 'abnormal': return 2, b'PRIVATE-INVALID'
                if mode == 'malformed': return 0, b'PRIVATE-INVALID'
                if mode == 'oversized': return 0, b'x'*4097
                if mode == 'failed':
                    value = success()
                    value.update(passed=False, responseVerified=False, assistantCount=0, resultCount=0,
                                 chunkCount=0, normalProviderEnd=False,
                                 failure={'code': 'provider_exception', 'cleanupFailure': False,
                                          'exceptionCategory': 'other', 'provenance': {'version': 1, 'origin': 'unknown'}})
                    return 1, json.dumps(value).encode()
                return 0, json.dumps(success()).encode()
            with patch.object(worker, 'Path', FixturePath), patch.object(worker.base, 'AUTH', Auth()), \
                    patch.object(worker.base.os, 'getuid', return_value=1001, create=True), \
                    patch.object(worker.base, 'artifact_workspace_snapshot', side_effect=snapshots), \
                    patch.object(worker.base, 'preflight', side_effect=preflight), \
                    patch.object(worker.base, 'bounded_process', side_effect=capture), \
                    patch.object(worker.base, 'oom_kills', side_effect=[0, None if mode == 'oom_unknown' else (1 if mode == 'oom' else 0)]), \
                    patch.dict(worker.base.os.environ, {'TEETIME_AUTH_ARTIFACT_SOURCE_SHA': SOURCE}):
                value = worker.run_worker(NONCE, SOURCE)
            self.assertNotIn('PRIVATE', json.dumps(value))
            self.assertEqual(validate_minimal_worker(0 if value['passed'] else 1, json.dumps(value).encode(), nonce=NONCE, source=SOURCE), value)
            return value, calls

    def test_success_is_diagnostic_only(self):
        value, calls = self.execute()
        self.assertTrue(value['passed']); self.assertEqual(len(calls), 1)
        self.assertTrue(value['taskProcessReaped']); self.assertEqual(value['taskExitCode'], 0)
        self.assertEqual(value['taskReceipt'], success())

    def test_preflight_failure_never_attempts_capture(self):
        for mode in ['preflight', 'preflight_mutation']:
            value, calls = self.execute(mode)
            self.assertFalse(value['passed']); self.assertEqual(calls, [])
            self.assertFalse(value['taskStarted']); self.assertIsNone(value['taskReceipt'])

    def test_task_failures_and_cleanup_uncertainty_cannot_pass(self):
        for mode in ['timeout', 'abnormal', 'malformed', 'oversized', 'failed', 'auth', 'workspace', 'oom', 'oom_unknown']:
            value, calls = self.execute(mode)
            self.assertFalse(value['passed']); self.assertEqual(len(calls), 1)
            self.assertTrue(value['taskStarted'])
            if mode == 'timeout': self.assertFalse(value['taskProcessReaped'])
            if mode == 'abnormal':
                self.assertTrue(value['taskProcessReaped']); self.assertIsNone(value['taskExitCode'])
            if mode in ['auth', 'workspace', 'oom', 'oom_unknown']:
                self.assertEqual(value['failureCategory'], 'cleanup'); self.assertEqual(value['taskReceipt'], success())
            elif mode == 'failed':
                self.assertIsNotNone(value['taskReceipt']); self.assertEqual(value['taskExitCode'], 1)
                self.assertEqual(value['failureCategory'], 'task')
            else: self.assertIsNone(value['taskReceipt'])

    def test_validator_rejects_contradictions_and_unknown_fields(self):
        valid, _ = self.execute()
        for field, bad in [('taskStarted', False), ('taskProcessReaped', False), ('taskExitCode', None),
                           ('preflightChecks', 5), ('authUnchanged', False), ('oomKillDelta', None),
                           ('version', True), ('failureCategory', 'PRIVATE'), ('extra', 0)]:
            value = copy.deepcopy(valid); value[field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_minimal_worker(0, json.dumps(value).encode(), nonce=NONCE, source=SOURCE)

    def test_identity_rejection_does_not_read_auth_or_start_preflight(self):
        with patch.object(worker.base, 'AUTH') as auth, patch.object(worker.base, 'preflight') as preflight, \
                patch.object(worker.base, 'oom_kills', return_value=0), \
                patch.object(worker.base.os, 'getuid', return_value=1001, create=True), \
                patch.object(worker.Path, 'cwd', return_value='/workspace'), \
                patch.dict(worker.base.os.environ, {'TEETIME_AUTH_ARTIFACT_SOURCE_SHA': 'c'*40}):
            value = worker.run_worker(NONCE, SOURCE)
            self.assertFalse(value['passed']); self.assertIsNone(value['taskReceipt'])
            auth.lstat.assert_not_called(); auth.read_bytes.assert_not_called(); preflight.assert_not_called()

    def test_validator_rejects_json_identity_exit_and_failed_nested_contradictions(self):
        valid, _ = self.execute()
        raw = json.dumps(valid).encode()
        for bad in [b'', b'x'*8193, raw.replace(b'"version": 1', b'"version": 1, "version": 1', 1),
                    raw.replace(b'"elapsedMs": 0', b'"elapsedMs": NaN'), b'\xff']:
            if bad == raw: continue
            with self.assertRaises(ValueError): validate_minimal_worker(0, bad, nonce=NONCE, source=SOURCE)
        for code, nonce, source in [(1, NONCE, SOURCE), (0, 'c'*32, SOURCE), (0, NONCE, 'c'*40)]:
            with self.assertRaises(ValueError): validate_minimal_worker(code, raw, nonce=nonce, source=source)
        failed, _ = self.execute('failed')
        failed['taskExitCode'] = 0
        with self.assertRaises(ValueError):
            validate_minimal_worker(1, json.dumps(failed).encode(), nonce=NONCE, source=SOURCE)
        preflight = copy.deepcopy(valid)
        preflight.update(passed=False, taskStarted=False, taskProcessReaped=False,
                         taskExitCode=None, taskReceipt=None, failureCategory='preflight')
        with self.assertRaises(ValueError):
            validate_minimal_worker(1, json.dumps(preflight).encode(), nonce=NONCE, source=SOURCE)

    def test_worker_rejects_private_unknown_and_missing_arguments_silently_before_auth(self):
        # Execute the actual script with a synthetic base auth trap. No normal
        # worker invocation, account, subprocess capture or network is possible.
        script = '''import pathlib,runpy,sys,types
path=pathlib.Path(sys.argv[1]); marker=pathlib.Path(sys.argv[2])
class Auth:
 def lstat(self): marker.write_text('PRIVATE-AUTH-ACCESS');raise RuntimeError('PRIVATE-AUTH')
 def read_bytes(self): marker.write_text('PRIVATE-AUTH-ACCESS');raise RuntimeError('PRIVATE-AUTH')
sys.modules['teetime_canary_worker']=types.SimpleNamespace(AUTH=Auth())
sys.argv=[str(path),*sys.argv[3:]]
runpy.run_path(str(path),run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder)/'auth-access'
            for args in [['--nonce', NONCE, '--source', SOURCE, '--PRIVATE-ARGUMENT'], [], ['--help']]:
                child = subprocess.run([sys.executable, '-I', '-c', script,
                    str(Path(__file__).with_name('teetime_minimal_worker.py')), str(marker), *args],
                    capture_output=True, timeout=10)
                self.assertEqual(child.returncode, 1)
                self.assertEqual(child.stdout, b''); self.assertEqual(child.stderr, b'')
                self.assertFalse(marker.exists())


if __name__ == '__main__': unittest.main()
