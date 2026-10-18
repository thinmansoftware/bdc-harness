"""Synthetic SSH substitute: no network, host login read or Docker resources."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('teetime_operator', ROOT/'invoke-teetime-auth-canary.py')
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
REAL_POPEN = subprocess.Popen


def messages():
    files = ['teetime_auth_receiver.py','teetime_canary_worker.py','teetime-canary-task.ts','teetime-canary-result.ts',
        'teetime_connect_proxy.py','run-teetime-auth-canary.py','teetime_canary_protocol.py','teetime_watchdog.py',
        'codex-probe-seccomp.json','teetime_bounded_process.py','teetime_proxy_receipt.py']
    ready = {'type':'READY','nonce':'1'*32,'image':'sha256:'+'a'*64,'sourceSha':'b'*40,
        'owner':'teetime-auth-'+'c'*12,'manifestSha256':'d'*64,'workerId':'e'*64,'gatewayId':'f'*64,
        'hashes':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in files}}
    result = {'passed':False,'cleanupVerified':True,'credentialReceived':True,'preflightPassed':False,
        'authUnchanged':True,'artifactVerified':False,'modelInvocations':0,'servedModelVerified':False,
        'preflightChecks':5,'authenticationRejected':True,'taskFailureCode':'not_started','terminalCount':0,
        'systemCategory':'none','diagnosticHint':'none','artifactExists':False,'artifactRegular':False,
        'artifactExactContent':False,'workspaceEntriesExact':False,'exceptionCategory':'none','aborted':False,
        'elapsedMs':0,'oomKillDelta':0,'proxyMetricsVerified':True,'taskDiagnosticsPresent':False}
    report = {'type':'RESULT','nonce':ready['nonce'],'owner':ready['owner'],'result':result,
        'cleanupErrors':[],'receiptDirectory':'synthetic-only', 'proxyMetrics':{
        'bytes':100,'header_or_destination_denied':0,'dns_denied':0,'byte_limit':0,'timeout':0,'rejected_or_closed':0,'closed':1}}
    return ready, report


class OperatorProtocolTests(unittest.TestCase):
    def run_fixture(self, mode):
        ready, report = messages()
        if mode == 'wrong_nonce':
            ready['nonce'] = '0'*32
        if mode == 'wrong_hash':
            ready['hashes']['teetime_canary_worker.py'] = '0'*64
        if mode == 'duplicate_ready':
            report = ready
        first = json.dumps(ready).encode()+b'\n'
        if mode == 'oversized':
            first = b'x'*16385+b'\n'
        if mode == 'early_exit':
            first = b''
        program = '''import sys,time,json,struct
first=%r
for offset in range(0,len(first),31):
 sys.stdout.buffer.write(first[offset:offset+31]); sys.stdout.buffer.flush(); time.sleep(.001)
if not first: sys.exit(1)
raw=sys.stdin.buffer.read(65541)
assert len(raw)>=4 and struct.unpack('!I',raw[:4])[0]==len(raw)-4
assert b'synthetic-invalid' in raw
sys.stdout.write(%r);sys.stdout.flush()
''' % (first, json.dumps(report)+'\n')
        def fake_ssh(argv, **kwargs):
            self.assertEqual(argv[:2], ['ssh','-T'])
            return REAL_POPEN([sys.executable,'-u','-c',program], **kwargs)
        original_read = Path.read_bytes
        def safe_read(path):
            if path == Path.home()/'.codex'/'auth.json':
                raise AssertionError('synthetic protocol test attempted real login read')
            return original_read(path)
        arguments = ['operator','--image','sha256:'+'a'*64,'--expected-sha','b'*40,'--synthetic']
        with patch.object(operator.subprocess,'Popen',side_effect=fake_ssh), \
             patch.object(operator.uuid,'uuid4',return_value=uuid.UUID('1'*32)), \
             patch.object(sys,'argv',arguments), patch.object(Path,'read_bytes',safe_read), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            result = operator.main()
        return result, output.getvalue()

    def test_fragmented_ready_and_complete_synthetic_protocol(self):
        code, output = self.run_fixture('valid')
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output)['result']['proxyMetricsVerified'])
        self.assertNotIn('synthetic-invalid', output)

    def test_rejects_foreign_or_oversized_ready_before_releasing_any_login(self):
        for mode in ['wrong_nonce','wrong_hash','oversized','early_exit']:
            with self.subTest(mode=mode), self.assertRaises(Exception):
                self.run_fixture(mode)

    def test_duplicate_ready_cannot_be_used_as_result(self):
        with self.assertRaises(Exception):
            self.run_fixture('duplicate_ready')


if __name__ == '__main__':
    unittest.main()
