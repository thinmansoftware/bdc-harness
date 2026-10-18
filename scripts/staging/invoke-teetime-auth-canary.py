"""Operator SSH transport. Real login is read only after verified remote READY."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid
from teetime_auth_receiver import validate_payload
from teetime_canary_protocol import encode_frame


def main():
    if not __debug__:
        raise ValueError('assertions required')
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--synthetic', action='store_true')
    parser.add_argument('--disconnect-before-auth', action='store_true')
    parser.add_argument('--frame-test', choices=['partial', 'oversized'])
    args = parser.parse_args()
    assert re.fullmatch('sha256:[a-f0-9]{64}', args.image)
    assert re.fullmatch('[a-f0-9]{40}', args.expected_sha)
    nonce = uuid.uuid4().hex
    command = r'''$ErrorActionPreference='Stop'; python "$env:USERPROFILE\teetime-config-diagnostic\run-teetime-auth-canary.py" --docker 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --image ''' + "'"+args.image+"' --expected-sha '"+args.expected_sha+"' --nonce '"+nonce+"'"
    encoded = base64.b64encode(command.encode('utf-16le')).decode()
    child = subprocess.Popen(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        'bdc-server', 'powershell', '-NoProfile', '-EncodedCommand', encoded], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    inbox = queue.Queue()
    def read_output():
        try:
            total = 0
            while True:
                line = child.stdout.readline(16385)
                if not line:
                    break
                total += len(line)
                if len(line) > 16384 or total > 32768:
                    raise ValueError('protocol output bound')
                inbox.put(json.loads(line))
        except BaseException:
            inbox.put(None)
        finally:
            inbox.put(None)
    reader_thread = threading.Thread(target=read_output, daemon=True)
    reader_thread.start()
    original = None
    auth_path = Path.home()/'.codex'/'auth.json'
    original_unchanged = True
    try:
        ready = inbox.get(timeout=75)
        assert isinstance(ready, dict) and ready['type'] == 'READY'
        assert set(ready) == {'type','nonce','image','sourceSha','owner','manifestSha256','workerId','gatewayId','hashes'}
        assert ready['nonce'] == nonce and ready['image'] == args.image and ready['sourceSha'] == args.expected_sha
        assert re.fullmatch('teetime-auth-[a-f0-9]{12}', ready['owner'])
        for key in ['manifestSha256', 'workerId', 'gatewayId']:
            assert re.fullmatch('[a-f0-9]{64}', ready[key])
        root = Path(__file__).parent
        filenames = ['teetime_auth_receiver.py', 'teetime_canary_worker.py', 'teetime-canary-task.ts', 'teetime-canary-result.ts',
            'teetime_connect_proxy.py', 'run-teetime-auth-canary.py', 'teetime_canary_protocol.py',
            'teetime_watchdog.py', 'codex-probe-seccomp.json', 'teetime_bounded_process.py', 'teetime_proxy_receipt.py']
        assert ready['hashes'] == {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in filenames}
        if args.disconnect_before_auth:
            child.kill(); child.wait(timeout=5)
            print(json.dumps({'disconnectInjected': True, 'owner': ready['owner'], 'credentialsUsed': False}))
            return 0
        if args.frame_test:
            payload = b'\x00\x00\x00\x04x' if args.frame_test == 'partial' else b'\x00\x01\x00\x01'
        elif args.synthetic:
            def token(value):
                return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
            jwt = token({'alg':'RS256'})+'.'+token({'exp':time.time()+7200,
                'email':'synthetic@example.invalid','https://api.openai.com/auth':{
                'chatgpt_account_id':'synthetic-invalid-account','chatgpt_plan_type':'plus'}})+'.aW52YWxpZA'
            payload = json.dumps({'auth_mode':'chatgpt','tokens':{'access_token':jwt,'id_token':jwt,
                'refresh_token':'synthetic-invalid','account_id':'synthetic-invalid-account'}}).encode()
        else:
            assert auth_path.stat().st_size <= 65536 and not auth_path.is_symlink()
            original = auth_path.read_bytes()
            payload = validate_payload(io.BytesIO(original), time.time())
        child.stdin.write(payload if args.frame_test else encode_frame(payload)); child.stdin.close()
        del payload
        report = inbox.get(timeout=180)
        assert isinstance(report, dict) and report['type'] == 'RESULT'
        assert set(report) == {'type','nonce','owner','result','cleanupErrors','receiptDirectory','proxyMetrics'}
        assert report['nonce'] == nonce and report['owner'] == ready['owner']
        assert child.wait(timeout=10) in [0, 1]
        assert inbox.get(timeout=5) is None
        # Only known status fields leave this operator; no raw remote diagnostics.
        result = report['result']
        keys = {'passed','cleanupVerified','credentialReceived','preflightPassed','authUnchanged',
                'artifactVerified','modelInvocations','servedModelVerified','preflightChecks','authenticationRejected','taskFailureCode',
                'terminalCount','systemCategory','diagnosticHint','artifactExists','artifactRegular','artifactExactContent','workspaceEntriesExact',
                'exceptionCategory','aborted','elapsedMs','oomKillDelta','proxyMetricsVerified','taskDiagnosticsPresent'}
        assert set(result) == keys
        assert all(type(result[k]) is bool for k in keys-{'modelInvocations','preflightChecks','taskFailureCode','terminalCount','systemCategory','diagnosticHint','exceptionCategory','elapsedMs','oomKillDelta'})
        assert result['exceptionCategory'] in ['none','aborted','auth_hint','quota_hint','model_access_hint','transport_hint','process_hint','other']
        assert type(result['elapsedMs']) is int and 0 <= result['elapsedMs'] <= 120000
        assert result['oomKillDelta'] is None or type(result['oomKillDelta']) is int and 0 <= result['oomKillDelta'] <= 1024
        if result['proxyMetricsVerified']:
            metrics = report['proxyMetrics']
            assert set(metrics) == {'bytes','header_or_destination_denied','dns_denied','byte_limit','timeout','rejected_or_closed','closed'}
            assert all(type(value) is int and 0 <= value <= 10**9 for value in metrics.values())
        else:
            assert report['proxyMetrics'] is None
        assert type(result['terminalCount']) is int and result['terminalCount'] in [0,1]
        assert result['systemCategory'] in ['none','task_list','file_change_failed','file_change_unexpected','format_warning','resume_warning','failback','other']
        assert result['diagnosticHint'] in ['none','permission_hint','sandbox_hint','other']
        assert result['taskFailureCode'] in ['not_started','worker_error','none','unexpected_system','terminal_rejected','provider_failed']
        assert type(result['preflightChecks']) is int and 0 <= result['preflightChecks'] <= 6
        assert type(result['modelInvocations']) is int and result['modelInvocations'] in [0,1]
        if original is not None:
            original_unchanged = auth_path.read_bytes() == original
        print(json.dumps({'owner':ready['owner'],'result':result,'proxyMetrics':report['proxyMetrics'],'synthetic':args.synthetic,
                          'originalAuthUnchanged':original_unchanged}))
        assert original_unchanged and result['cleanupVerified'] and result['proxyMetricsVerified']
        if args.frame_test:
            assert not result['credentialReceived'] and not result['passed'] and result['modelInvocations'] == 0
        elif args.synthetic:
            assert result['credentialReceived'] and not result['passed'] and result['modelInvocations'] == 0
            assert result['preflightChecks'] == 5 and result['authenticationRejected']
        else:
            assert result['passed']
        return 0
    finally:
        if child.poll() is None:
            child.kill(); child.wait(timeout=5)
        if child.stdin is not None and not child.stdin.closed:
            try:
                child.stdin.close()
            except OSError:
                pass
        reader_thread.join(timeout=3)
        if reader_thread.is_alive():
            raise ValueError('operator protocol reader did not stop')
        child.stdout.close()
        if original is not None and auth_path.read_bytes() != original:
            raise ValueError('original login changed during canary')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit('Canary not verified; inspect sanitized owned-resource receipt. No credential data logged.') from None
