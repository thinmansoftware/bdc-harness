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


def deliver_observation(child, raw, timeout=15, *, deadline=None, _writers=None):
    """Bounded pre-auth write. Failure kills/reaps only the owned SSH child."""
    return _deliver_input(child,raw,timeout,65537,deadline,_writers)


def _deliver_input(child, raw, timeout, maximum, deadline=None, writers=None):
    if type(raw) is not bytes or not 1 <= len(raw) <= maximum:
        raise ValueError('bounded observation delivery required')
    def remaining(limit):
        if deadline is None:return limit
        value=deadline-time.monotonic()
        if value<=0:raise TimeoutError('operator outer deadline')
        return min(limit,value)
    result = queue.Queue(maxsize=1)
    def write():
        try:
            child.stdin.write(raw)
            child.stdin.flush()
            result.put(True)
        except (BrokenPipeError, OSError):
            result.put(False)
    writer = threading.Thread(target=write, daemon=True)
    if writers is not None:writers.append(writer)
    try:
        writer.start()
        if result.get(timeout=remaining(timeout)) is not True:
            raise ValueError('observation delivery failed')
        writer.join(timeout=remaining(3))
        if writer.is_alive():
            raise ValueError('observation writer did not stop')
    except BaseException:
        # One failed/expired reap must not skip writer settlement. At an expired
        # outer deadline, zero-time polls/joins still record the uncertainty.
        def cleanup_remaining(limit):
            return limit if deadline is None else max(0,min(limit,deadline-time.monotonic()))
        uncertain=False
        try:
            if child.poll() is None:child.kill()
        except BaseException:uncertain=True
        try:child.wait(timeout=cleanup_remaining(5))
        except BaseException:uncertain=True
        try:
            if writer.ident is not None:writer.join(timeout=cleanup_remaining(3))
            if writer.is_alive():uncertain=True
        except BaseException:uncertain=True
        if uncertain:
            raise ValueError('observation delivery cleanup uncertain') from None
        raise


def deliver_credential_frame(child,raw,timeout=15,*,deadline,_writers=None):
    if (type(raw) is not bytes or not 5<=len(raw)<=65540
            or int.from_bytes(raw[:4],'big')!=len(raw)-4):
        raise ValueError('single bounded credential frame required')
    return _deliver_input(child,raw,timeout,65540,deadline,_writers)


def supervised_command(execution, args, nonce):
    command = r'''$ErrorActionPreference='Stop'; & "$env:USERPROFILE\.bun\bin\bun.exe" --no-env-file "$env:USERPROFILE\teetime-supervised-01\execution-harness\scripts\staging\teetime-supervised-controller.ts" --claim-model --input-sha256 '''+"'"+args.input_sha256+"' --execution-sha256 '"+args.demo_package_hash+"' --source-manifest-sha256 '"+args.source_manifest_sha256+"' --source-sha '"+args.artifact_source+"' --review-head '"+args.plan_head+"' --nonce '"+nonce+"'"
    if execution.binding['attempt'] == 4:
        command = command.replace('\\execution-harness\\', '\\transport-repair-execution-harness\\').replace(
            ' --claim-model ', ' --claim-transport-repair ')
    elif execution.predecessors:
        command = command.replace('\\execution-harness\\', '\\diagnostic-execution-harness\\').replace(
            ' --claim-model ', ' --claim-diagnostic-successor ')
    elif execution.predecessor is not None:
        command = command.replace('\\execution-harness\\', '\\successor-execution-harness\\').replace(
            ' --claim-model ', ' --claim-successor ')
    return command


def minimal_supervised_command(execution, args, nonce):
    """Fixed supervised entry only; matching bytes alone never grant execution."""
    from teetime_minimal_execution import MinimalExecution
    if type(execution) is not MinimalExecution:
        raise ValueError('separate minimal execution required')
    for value,size in [(nonce,32),(args.input_sha256,64),(args.diagnostic_package_hash,64),
            (args.source_manifest_sha256,64),(args.diagnostic_source,40),(args.plan_head,40)]:
        if type(value) is not str or re.fullmatch('[a-f0-9]{'+str(size)+'}',value) is None:
            raise ValueError('closed minimal command identities required')
    if (args.input_sha256!=execution.operator_input_hash or args.diagnostic_package_hash!=execution.package_hash
            or args.diagnostic_source!=execution.source):
        raise ValueError('minimal command packet differs')
    return (r'''$ErrorActionPreference='Stop'; & "$env:USERPROFILE\.bun\bin\bun.exe" --no-env-file "$env:USERPROFILE\teetime-supervised-01\minimal-diagnostic-execution-harness\scripts\staging\teetime-supervised-controller.ts" --claim-minimal-diagnostic --input-sha256 '''
        +"'"+args.input_sha256+"' --execution-sha256 '"+args.diagnostic_package_hash
        +"' --source-manifest-sha256 '"+args.source_manifest_sha256+"' --source-sha '"+args.diagnostic_source
        +"' --review-head '"+args.plan_head+"' --nonce '"+nonce+"'")


MINIMAL_OUTER_SECONDS=450
MINIMAL_TRANSPORT_SECONDS=420


def run_minimal_operator(args,root):
    from teetime_minimal_execution import parse_minimal_execution
    from teetime_minimal_protocol import (diagnostic_hashes,validate_diagnostic_selector,
        validate_diagnostic_ready,validate_diagnostic_report)
    from teetime_plan_observation import observe_minimal_plan
    from teetime_successor_observation import frozen_file
    from teetime_joined_fixture import strict_json
    validate_diagnostic_selector(args.task,args.diagnostic_source,args.artifact_source,args.demo_package_hash)
    if args.synthetic or args.disconnect_before_auth or args.frame_test:
        raise ValueError('minimal diagnostic cannot be a credential fixture')
    for value,size in [(args.diagnostic_package_hash,64),(args.plan_head,40),(args.input_sha256,64),
            (args.source_manifest_sha256,64)]:
        if type(value) is not str or re.fullmatch('[a-f0-9]{'+str(size)+'}',value) is None:
            raise ValueError('closed minimal operator identities required')
    source_root=Path(root).resolve().parents[1]
    packet=frozen_file(source_root/'minimal-execution.json','sha256:'+args.diagnostic_package_hash,32768)
    execution=parse_minimal_execution(packet,args.diagnostic_package_hash)
    if (execution.image,execution.source,execution.base_source,execution.operator_input_hash)!=(
            args.image,args.diagnostic_source,args.expected_sha,args.input_sha256):
        raise ValueError('minimal operator packet differs')
    inventory=frozen_file(source_root.parent/'minimal-diagnostic-execution-source-manifest.json',
        'sha256:'+args.source_manifest_sha256,2*1024*1024)
    hashes=diagnostic_hashes(root,execution.source,execution.base_source)
    if hashes!=dict(execution.selected_hashes):raise ValueError('minimal local helpers differ')
    nonce=uuid.uuid4().hex
    observation=observe_minimal_plan(packet,args.diagnostic_package_hash,inventory,
        args.source_manifest_sha256,args.plan_head,nonce)
    command=minimal_supervised_command(execution,args,nonce)
    encoded=base64.b64encode(command.encode('utf-16le')).decode('ascii')
    began=time.monotonic();outer=began+MINIMAL_OUTER_SECONDS;transport=began+MINIMAL_TRANSPORT_SECONDS
    def remaining(deadline,maximum):
        value=deadline-time.monotonic()
        if value<=0:raise TimeoutError('minimal operator deadline')
        return min(value,maximum)
    child=None;watchdog=None;reader=None;writers=[]
    watchdog_started=False;reader_started=False
    expired=threading.Event()
    def expire():
        expired.set()
        try:
            if child is not None and child.poll() is None:child.kill()
        except OSError:pass
    inbox=queue.Queue();protocol_error=object()
    def read_output():
        try:
            total=0
            while True:
                line=child.stdout.readline(32770)
                if not line:break
                total+=len(line)
                if len(line)>32769 or total>65536 or not line.endswith(b'\n') or not line.isascii():
                    raise ValueError('minimal operator protocol bound')
                inbox.put((line[:-1],strict_json(line)))
        except BaseException:inbox.put(protocol_error)
        finally:inbox.put(None)
    original=None;auth_path=Path.home()/'.codex/auth.json';record=None;result_code=None
    try:
        child=subprocess.Popen(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
            'bdc-server','powershell','-NoProfile','-EncodedCommand',encoded],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        watchdog=threading.Timer(max(0,transport-time.monotonic()),expire);watchdog.daemon=True
        watchdog.start();watchdog_started=True
        reader=threading.Thread(target=read_output,daemon=True)
        reader.start();reader_started=True
        deliver_observation(child,observation+b'\n',timeout=remaining(transport,15),deadline=outer,_writers=writers)
        del observation
        first=inbox.get(timeout=remaining(transport,120))
        if type(first) is not tuple:raise ValueError('minimal READY missing')
        _,ready=first
        validate_diagnostic_ready(ready,nonce=nonce,image=execution.image,base_source=execution.base_source,
            source=execution.source,hashes=hashes)
        # No original login read precedes this independent exact READY check.
        remaining(transport,15)
        if expired.is_set():raise TimeoutError('minimal transport expired before account read')
        original=frozen_file(auth_path,limit=65536)
        payload=validate_payload(io.BytesIO(original),time.time())
        frame=encode_frame(payload)
        try:deliver_credential_frame(child,frame,timeout=remaining(transport,15),deadline=outer,_writers=writers)
        finally:del payload,frame
        child.stdin.close()
        final=inbox.get(timeout=remaining(transport,420))
        if type(final) is not tuple:raise ValueError('minimal RESULT missing')
        report_raw,_=final
        exit_code=child.wait(timeout=remaining(transport,10))
        if inbox.get(timeout=remaining(transport,5)) is not None:
            raise ValueError('minimal trailing protocol data')
        report=validate_diagnostic_report(report_raw,exit_code,ready=ready)
        if expired.is_set():raise TimeoutError('minimal SSH deadline exceeded')
        record={'owner':ready['owner'],'task':'minimal-diagnostic','diagnosticSourceSha':execution.source,
            'result':report['result'],'proxyMetrics':report['proxyMetrics'],'originalAuthUnchanged':True}
        result_code=0 if report['result']['passed'] else 1
    finally:
        errors=[]
        def cleanup_remaining(limit):return max(0,min(limit,outer-time.monotonic()))
        def attempt(action):
            try:action()
            except BaseException:errors.append(True)
        try:
            if watchdog is not None:attempt(watchdog.cancel)
            if child is not None:
                def kill_owned():
                    if child.poll() is None:child.kill()
                attempt(kill_owned)
                attempt(lambda:child.wait(timeout=cleanup_remaining(10)))
            writer_done=True
            for writer in writers:
                if writer.ident is not None:attempt(lambda w=writer:w.join(timeout=cleanup_remaining(3)))
                if writer.is_alive():writer_done=False;errors.append(True)
            reader_done=True
            if reader is not None:
                if reader_started or reader.ident is not None:attempt(lambda:reader.join(timeout=cleanup_remaining(3)))
                if reader.is_alive():reader_done=False;errors.append(True)
            if watchdog is not None:
                if watchdog_started or watchdog.ident is not None:attempt(lambda:watchdog.join(timeout=cleanup_remaining(1)))
                if watchdog.is_alive():errors.append(True)
            if child is not None:
                # Buffered close can acquire a writer's lock or flush to a live
                # nonreading peer. Do neither without settled ownership proof.
                def close_input():
                    if child.stdin is not None and not child.stdin.closed:
                        if not writer_done or child.poll() is None:
                            raise ValueError('minimal input close uncertain')
                        child.stdin.close()
                attempt(close_input)
                if reader_done:attempt(child.stdout.close)
            if original is not None:
                def original_readback():
                    if time.monotonic()>=outer or frozen_file(auth_path,limit=65536)!=original:
                        raise ValueError('original login equality not verified')
                attempt(original_readback)
            attempt(lambda:remaining(outer,1))
        finally:
            if original is not None:del original
        if errors:raise ValueError('minimal operator cleanup uncertain') from None
    if record is None or result_code is None:raise ValueError('minimal operator result absent')
    print(json.dumps(record,sort_keys=True,separators=(',',':')))
    return result_code


def main():
    if not __debug__:
        raise ValueError('assertions required')
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--synthetic', action='store_true')
    parser.add_argument('--disconnect-before-auth', action='store_true')
    parser.add_argument('--frame-test', choices=['partial', 'oversized'])
    parser.add_argument('--task', choices=['filesystem', 'artifact', 'supervised-demo', 'minimal-diagnostic'], default='filesystem')
    parser.add_argument('--artifact-source')
    parser.add_argument('--demo-package-hash')
    parser.add_argument('--plan-head')
    parser.add_argument('--input-sha256')
    parser.add_argument('--source-manifest-sha256')
    parser.add_argument('--diagnostic-source')
    parser.add_argument('--diagnostic-package-hash')
    args = parser.parse_args()
    assert re.fullmatch('sha256:[a-f0-9]{64}', args.image)
    assert re.fullmatch('[a-f0-9]{40}', args.expected_sha)
    if args.task=='minimal-diagnostic':return run_minimal_operator(args,Path(__file__).parent)
    if args.diagnostic_source is not None or args.diagnostic_package_hash is not None:
        parser.error('minimal-only arguments rejected')
    nonce = uuid.uuid4().hex
    root = Path(__file__).parent
    artifact_mode = args.task in ['artifact','supervised-demo']
    execution=None
    observation = None
    if args.task=='supervised-demo':
        from teetime_demo_execution import parse_demo_execution, MAX_EXECUTION_BYTES
        from teetime_plan_observation import observe_plan
        for value, size in [(args.demo_package_hash,64), (args.plan_head,40),
                            (args.input_sha256,64), (args.source_manifest_sha256,64)]:
            if type(value) is not str or re.fullmatch('[a-f0-9]{'+str(size)+'}',value) is None:
                raise ValueError('closed supervised operator arguments required')
        if args.synthetic or args.disconnect_before_auth or args.frame_test:
            raise ValueError('real supervised phase cannot be used as a transport fixture')
        path=root.resolve().parents[1]/'demo-execution.json'
        if not path.is_file() or path.is_symlink() or path.stat().st_size>MAX_EXECUTION_BYTES:
            raise ValueError('bounded frozen local package required')
        execution_raw=path.read_bytes()
        execution=parse_demo_execution(execution_raw,args.demo_package_hash)
        if (execution.image,execution.source,execution.base_source)!=(args.image,args.artifact_source,args.expected_sha):
            raise ValueError('operator execution identity differs')
        observation=observe_plan(execution_raw,args.demo_package_hash,args.plan_head,nonce)
    elif any(value is not None for value in [args.demo_package_hash,args.plan_head,
                                            args.input_sha256,args.source_manifest_sha256]):
        parser.error('demo-only arguments rejected')
    if artifact_mode:
        from teetime_auth_artifact_protocol import artifact_hashes, validate_selector, validate_ready, validate_report, POLICY_PATH
        from teetime_joined_fixture import strict_json
        validate_selector(args.task, args.artifact_source, nonce)
        frozen_hashes = artifact_hashes(root, args.artifact_source, args.expected_sha)
        context = 'teetime-auth-artifact-'+args.artifact_source+'\\scripts\\staging'
    else:
        if args.artifact_source is not None:
            parser.error('artifact-only source rejected in filesystem mode')
        context = 'teetime-config-diagnostic'
    command = r'''$ErrorActionPreference='Stop'; python "$env:USERPROFILE\CANARY_CONTEXT\run-teetime-auth-canary.py" --docker 'C:\Program Files\Docker\Docker\resources\bin\docker.exe' --image ''' + "'"+args.image+"' --expected-sha '"+args.expected_sha+"' --nonce '"+nonce+"'"
    command = command.replace('CANARY_CONTEXT', context)
    if artifact_mode:
        command += " --task artifact --artifact-source '"+args.artifact_source+"'"
    if execution is not None:
        command = supervised_command(execution, args, nonce)
    encoded = base64.b64encode(command.encode('utf-16le')).decode()
    child = subprocess.Popen(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        'bdc-server', 'powershell', '-NoProfile', '-EncodedCommand', encoded], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    inbox = queue.Queue()
    protocol_error = object()
    def read_output():
        try:
            total = 0
            while True:
                line_limit = 98304 if execution else 16384
                line = child.stdout.readline(line_limit+1)
                if not line:
                    break
                total += len(line)
                if len(line) > line_limit or total > (196608 if execution else 32768):
                    raise ValueError('protocol output bound')
                inbox.put(strict_json(line) if artifact_mode else json.loads(line))
        except BaseException:
            inbox.put(protocol_error if artifact_mode else None)
        finally:
            inbox.put(None)
    reader_thread = threading.Thread(target=read_output, daemon=True)
    reader_thread.start()
    original = None
    auth_path = Path.home()/'.codex'/'auth.json'
    original_unchanged = True
    try:
        if observation is not None:
            deliver_observation(child, observation+b'\n')
            del observation
        ready = inbox.get(timeout=120 if execution else 75)
        if artifact_mode:
            validate_ready(ready, nonce=nonce, image=args.image, base_source=args.expected_sha,
                           source=args.artifact_source, hashes=frozen_hashes, execution=execution)
        else:
            assert isinstance(ready, dict) and ready['type'] == 'READY'
            assert set(ready) == {'type','nonce','image','sourceSha','owner','manifestSha256','workerId','gatewayId','hashes'}
            assert ready['nonce'] == nonce and ready['image'] == args.image and ready['sourceSha'] == args.expected_sha
            assert re.fullmatch('teetime-auth-[a-f0-9]{12}', ready['owner'])
            for key in ['manifestSha256', 'workerId', 'gatewayId']:
                assert re.fullmatch('[a-f0-9]{64}', ready[key])
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
        report = inbox.get(timeout=690 if execution else 180)
        if artifact_mode:
            child_exit = child.wait(timeout=10)
            assert inbox.get(timeout=5) is None
            if original is not None:
                original_unchanged = auth_path.read_bytes() == original
            assert original_unchanged
            # The validator checks cleanup before independently reparsing artifact bytes.
            validate_report(report, child_exit, ready=ready, policy_hash=frozen_hashes[POLICY_PATH],execution=execution)
            outcome = report['result']
            result = outcome['artifactResult']
            assert outcome['cleanupVerified'] and outcome['proxyMetricsVerified']
            if args.frame_test:
                assert not outcome['credentialReceived'] and not outcome['passed'] and result['modelInvocations'] == 0
            elif args.synthetic:
                assert outcome['credentialReceived'] and not outcome['passed'] and result['modelInvocations'] == 0
                assert result['preflightChecks'] == 5 and result['authenticationRejected'] and not result['taskStarted']
            else:
                assert outcome['passed']
            print(json.dumps({'owner': ready['owner'], 'task': args.task, 'artifactSourceSha': args.artifact_source,
                'result': outcome, 'proxyMetrics': report['proxyMetrics'], 'synthetic': args.synthetic,
                'originalAuthUnchanged': original_unchanged}))
            return 0
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
