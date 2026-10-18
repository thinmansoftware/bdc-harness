"""Fake SSH only. Real host login reads and network/Docker access are forbidden."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import teetime_auth_artifact_protocol as protocol
from teetime_fixed_artifact import expected_artifact, validate_task_result

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('artifact_operator', ROOT/'invoke-teetime-auth-canary.py')
operator = importlib.util.module_from_spec(spec); spec.loader.exec_module(operator)
REAL_POPEN = subprocess.Popen


class OperatorArtifactTests(unittest.TestCase):
    def run_fixture(self, mode):
        nonce, source, base = '1'*32, '2'*40, '3'*40
        image = 'sha256:'+'4'*64
        repo = ROOT.resolve().parents[1]
        hashes = {path: hashlib.sha256((repo/path).read_bytes()).hexdigest() for path in protocol.ALL_PATHS}
        policy = hashes[protocol.POLICY_PATH]
        ready = {'type': 'READY', 'nonce': nonce, 'image': image, 'sourceSha': base,
            'owner': 'teetime-auth-'+'5'*12, 'manifestSha256': '6'*64, 'workerId': '7'*64,
            'gatewayId': '8'*64, 'hashes': hashes, 'task': 'artifact', 'artifactSourceSha': source,
            'artifactContractHash': protocol.artifact_identity(nonce, policy)}
        worker = protocol.empty_worker_result()
        worker.update({'preflightChecks': 5, 'authenticationRejected': True, 'authUnchanged': True,
                      'workspaceUnchanged': True, 'oomKillDelta': 0, 'failureCategory': 'rejected'})
        success = mode in ['success', 'nonzero_success', 'changed_auth', 'cleanup_failed', 'trailing_garbage']
        if success:
            packet = {'kind': 'fixed-artifact-v1', 'passed': True,
                'artifactBase64': base64.b64encode(expected_artifact(nonce, policy)).decode(),
                'modelInvocations': 1, 'assistantCount': 1, 'resultCount': 1, 'thinkingCount': 0,
                'normalProviderEnd': True, 'providerIteratorClosed': True, 'aborted': False,
                'failureCategory': 'none', 'servedModelVerified': False}
            candidate = validate_task_result(0, json.dumps(packet).encode(), nonce=nonce, policy_hash=policy)
            worker.update(packet); del worker['kind']
            worker.update({'taskStarted': True, 'preflightPassed': True, 'preflightChecks': 6,
                'authenticationRejected': False, 'artifactVerified': True, 'taskDiagnosticsPresent': True,
                'artifactHash': candidate.artifact_hash, 'bindingHash': candidate.binding_hash,
                'manifestHash': candidate.manifest_hash, 'sourceTree': candidate.source_tree})
        report = {'type': 'RESULT', 'nonce': nonce, 'owner': ready['owner'],
            'result': {'passed': success, 'cleanupVerified': mode != 'cleanup_failed',
                'credentialReceived': True, 'proxyMetricsVerified': True, 'artifactResult': worker},
            'cleanupErrors': [], 'receiptDirectory': 'synthetic-owned-receipt', 'proxyMetrics': {
                'bytes': 100, 'header_or_destination_denied': 0, 'dns_denied': 0,
                'byte_limit': 0, 'timeout': 0, 'rejected_or_closed': 0, 'closed': 1},
            'task': 'artifact', 'artifactSourceSha': source, 'artifactContractHash': ready['artifactContractHash']}
        for tag, field, value in [('wrong_task', 'task', 'filesystem'), ('wrong_source', 'artifactSourceSha', 'f'*40),
            ('wrong_contract', 'artifactContractHash', '0'*64), ('wrong_nonce', 'nonce', '0'*32)]:
            if mode == tag: ready[field] = value
        if mode == 'wrong_hash': ready['hashes'] = {**hashes, protocol.IMAGE_PATHS[0]: '0'*64}
        if mode == 'duplicate_ready': report = ready
        if mode == 'wrong_result_task': report['task'] = 'filesystem'
        exit_code = 0 if success and mode != 'nonzero_success' else 1
        first = json.dumps(ready)+'\n'
        if mode == 'duplicate_key_ready':
            first = first.replace('"task": "artifact"', '"task":"artifact","task":"artifact"')
        final = json.dumps(report)+'\n'+('invalid-json\n' if mode == 'trailing_garbage' else '')
        program = '''import sys,struct
sys.stdout.write(%r);sys.stdout.flush()
raw=sys.stdin.buffer.read(65541)
assert len(raw)>=4 and struct.unpack('!I',raw[:4])[0]==len(raw)-4
assert b'synthetic-invalid' in raw
sys.stdout.write(%r);sys.stdout.flush()
sys.exit(%r)
''' % (first, final, exit_code)
        def fake_ssh(argv, **kwargs):
            self.assertEqual(argv[:2], ['ssh', '-T'])
            command = base64.b64decode(argv[-1]).decode('utf-16le')
            self.assertIn('--task artifact', command)
            self.assertIn('teetime-auth-artifact-'+source, command)
            return REAL_POPEN([sys.executable, '-u', '-c', program], **kwargs)
        def token(value):
            return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
        jwt = token({'alg': 'RS256'})+'.'+token({'exp': time.time()+7200})+'.synthetic-invalid'
        payload = json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': jwt, 'id_token': jwt,
            'refresh_token': 'synthetic-invalid', 'account_id': 'synthetic-invalid-account'}}).encode()
        login = Path.home()/'.codex'/'auth.json'
        original_read, original_stat, original_link = Path.read_bytes, Path.stat, Path.is_symlink
        reads = []
        def safe_read(path):
            if path == login:
                reads.append('fake-login-read')
                if not success:
                    raise AssertionError('real-mode fixture reached login before valid READY')
                return b'changed' if mode == 'changed_auth' and len(reads) > 1 else payload
            return original_read(path)
        def safe_stat(path, *args, **kwargs):
            return SimpleNamespace(st_size=len(payload)) if path == login else original_stat(path, *args, **kwargs)
        arguments = ['operator', '--image', image, '--expected-sha', base,
                     '--task', 'artifact', '--artifact-source', source]
        if mode in ['synthetic', 'duplicate_ready', 'wrong_result_task']: arguments += ['--synthetic']
        self.output = io.StringIO()
        self.reads = reads
        with patch.object(operator.subprocess, 'Popen', side_effect=fake_ssh), \
            patch.object(protocol, 'artifact_hashes', return_value=hashes), \
            patch.object(operator.uuid, 'uuid4', return_value=uuid.UUID(nonce)), \
            patch.object(sys, 'argv', arguments), patch.object(Path, 'read_bytes', safe_read), \
            patch.object(Path, 'stat', safe_stat), \
            patch.object(Path, 'is_symlink', lambda path: False if path == login else original_link(path)), \
            contextlib.redirect_stdout(self.output):
            code = operator.main()
        return code, self.output.getvalue()

    def test_synthetic_rejection_uses_new_schema_without_reading_host_login(self):
        code, output = self.run_fixture('synthetic')
        self.assertEqual(code, 0)
        result = json.loads(output)['result']['artifactResult']
        self.assertTrue(result['authenticationRejected'])
        self.assertEqual(result['modelInvocations'], 0)
        self.assertNotIn('synthetic-invalid', output)
        self.assertEqual(self.reads, [])

    def test_foreign_ready_never_releases_login(self):
        for mode in ['wrong_task', 'wrong_source', 'wrong_contract', 'wrong_nonce', 'wrong_hash', 'duplicate_key_ready']:
            with self.subTest(mode=mode), self.assertRaises(Exception):
                self.run_fixture(mode)
            self.assertEqual(self.reads, [])

    def test_success_reparses_actual_artifact_only_after_clean_result_and_auth(self):
        code, output = self.run_fixture('success')
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)['result']['passed'])
        self.assertGreaterEqual(len(self.reads), 2)
        self.assertNotIn('synthetic-invalid', output)

    def test_uncertain_exit_cleanup_auth_and_selector_cannot_emit_artifact(self):
        for mode in ['nonzero_success', 'changed_auth', 'cleanup_failed', 'duplicate_ready', 'wrong_result_task', 'trailing_garbage']:
            with self.subTest(mode=mode), self.assertRaises(Exception):
                self.run_fixture(mode)
            self.assertNotIn('artifactBase64', self.output.getvalue())


if __name__ == '__main__':
    unittest.main()
