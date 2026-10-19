"""Windows remote controller. READY precedes stdin auth; no raw worker logging."""
import argparse
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parent))
from teetime_auth_receiver import validate_payload
from teetime_canary_protocol import read_frame
from teetime_watchdog import cleanup
from teetime_bounded_process import capture
from teetime_proxy_receipt import parse_proxy_receipt
from teetime_artifact_workspace import worker_tmpfs


def parse_controller_arguments(argv=None):
    class SilentParser(argparse.ArgumentParser):
        def error(self, _message):
            raise ValueError('controller arguments rejected')
    parser = SilentParser(add_help=False)
    parser.add_argument('--docker', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--nonce', required=True)
    parser.add_argument('--task', choices=['filesystem', 'artifact', 'supervised-demo', 'minimal-diagnostic'], default='filesystem')
    parser.add_argument('--artifact-source')
    parser.add_argument('--demo-package-hash')
    parser.add_argument('--diagnostic-source')
    args = parser.parse_args(argv)
    if args.task == 'minimal-diagnostic':
        from teetime_minimal_protocol import validate_diagnostic_selector
        validate_diagnostic_selector(args.task, args.diagnostic_source, args.artifact_source, args.demo_package_hash)
    elif args.diagnostic_source is not None:
        raise ValueError('diagnostic-only source rejected')
    return args


def gateway_command(task, execution):
    if task == 'minimal-diagnostic': return ['-I', '-', '--diagnostic-receipt']
    return ['-I', '-', '--task', 'supervised-demo'] if execution else ['-I', '-']


def diagnostic_worker_dispatch(args, worker_id):
    from teetime_minimal_protocol import validate_diagnostic_selector
    validate_diagnostic_selector(args.task, args.diagnostic_source, args.artifact_source, args.demo_package_hash)
    if re.fullmatch('[a-f0-9]{64}', worker_id) is None or re.fullmatch('[a-f0-9]{32}', args.nonce) is None:
        raise ValueError('diagnostic worker identity rejected')
    return ([args.docker, 'exec', '-w', '/workspace', worker_id, 'python3', '-I',
             '/app/scripts/staging/teetime_minimal_worker.py', '--nonce', args.nonce,
             '--source', args.diagnostic_source], 180, 8192)


def main():
    args = parse_controller_arguments()
    if os.name != 'nt' or not __debug__:
        raise ValueError('Windows assertion-enabled controller required')
    assert re.fullmatch('sha256:[a-f0-9]{64}', args.image)
    assert re.fullmatch('[a-f0-9]{40}', args.expected_sha)
    assert re.fullmatch('[a-f0-9]{32}', args.nonce)
    root = Path(__file__).parent
    artifact_mode = args.task in ['artifact','supervised-demo']
    diagnostic_mode = args.task == 'minimal-diagnostic'
    readonly_mode = artifact_mode or diagnostic_mode
    execution=execution_raw=None
    if args.task=='supervised-demo':
        from teetime_demo_execution import parse_demo_execution,MAX_EXECUTION_BYTES,DEMO_LIMITS
        path=root.resolve().parents[1]/'demo-execution.json'
        assert path.is_file() and not path.is_symlink() and path.stat().st_size<=MAX_EXECUTION_BYTES
        execution_raw=path.read_bytes()
        execution=parse_demo_execution(execution_raw,args.demo_package_hash)
        assert (execution.image,execution.source,execution.base_source)==(args.image,args.artifact_source,args.expected_sha)
    elif args.demo_package_hash is not None:
        raise ValueError('demo-only package hash rejected')
    if diagnostic_mode:
        from teetime_minimal_protocol import (diagnostic_hashes, diagnostic_identity,
            IMAGE_PATHS as DIAGNOSTIC_IMAGE_PATHS, validate_diagnostic_ready,
            validate_diagnostic_report, sanitize_cleanup_errors)
        from teetime_minimal_worker_result import validate_minimal_worker
        from teetime_proxy_diagnostic_receipt import parse_proxy_diagnostic_receipt
        from teetime_joined_fixture import strict_json
        frozen_hashes = diagnostic_hashes(root, args.diagnostic_source, args.expected_sha)
        contract_hash = diagnostic_identity(args.nonce, args.image, args.expected_sha, args.diagnostic_source, frozen_hashes)
    elif artifact_mode:
        from teetime_auth_artifact_protocol import (artifact_hashes, artifact_identity, IMAGE_PATHS,
            POLICY_PATH, empty_worker_result, validate_selector, validate_worker_result)
        from teetime_joined_fixture import strict_json
        validate_selector(args.task, args.artifact_source, args.nonce)
        frozen_hashes = artifact_hashes(root, args.artifact_source, args.expected_sha)
        contract_hash = artifact_identity(args.nonce, frozen_hashes[POLICY_PATH])
        if execution is not None:
            from teetime_auth_artifact_protocol import validate_execution_context
            validate_execution_context(execution,args.image,args.expected_sha,args.artifact_source,frozen_hashes[POLICY_PATH])
            contract_hash=execution.package_hash
    elif args.artifact_source is not None:
        raise ValueError('artifact-only source rejected in filesystem mode')
    proxy_source = (root/'teetime_connect_proxy.py').read_bytes()
    owner = 'teetime-auth-' + uuid.uuid4().hex[:12]
    receipt = Path.home()/owner
    receipt.mkdir(exist_ok=False)
    duration = 300 if diagnostic_mode else (DEMO_LIMITS['watchdogSeconds'] if execution else 210)
    controller_deadline = time.monotonic()+duration
    manifest = {'owner': owner, 'deadline': time.time()+duration, 'containers': [], 'networks': []}
    outcome = {'passed': False, 'cleanupVerified': False, 'credentialReceived': False,
               'preflightPassed': False, 'authUnchanged': False, 'artifactVerified': False,
               'modelInvocations': 0, 'servedModelVerified': False, 'preflightChecks': 0,
               'authenticationRejected': False, 'taskFailureCode': 'not_started',
               'terminalCount': 0, 'systemCategory': 'none', 'diagnosticHint': 'none',
               'artifactExists': False, 'artifactRegular': False, 'artifactExactContent': False, 'workspaceEntriesExact': False,
               'exceptionCategory': 'none', 'aborted': False, 'elapsedMs': 0, 'oomKillDelta': None,
               'proxyMetricsVerified': False, 'taskDiagnosticsPresent': False}
    if artifact_mode:
        outcome = {'passed': False, 'cleanupVerified': False, 'credentialReceived': False,
                   'proxyMetricsVerified': False, 'artifactResult': empty_worker_result(demo=execution is not None)}
    if diagnostic_mode:
        outcome = {'passed': False, 'cleanupVerified': False, 'credentialReceived': False,
                   'proxyMetricsVerified': False, 'workerExitCode': None, 'workerResult': None}
    proxy_thread = None
    proxy_results = queue.Queue(maxsize=1)
    proxy_ready = threading.Event()
    proxy_metrics = None
    ids = {}
    announced_ready = None
    def d(*parts, **kwargs):
        timeout = kwargs.pop('timeout', 15)
        if diagnostic_mode:
            timeout = min(timeout, controller_deadline-time.monotonic())
            if timeout <= 0: raise TimeoutError('controller deadline')
        return subprocess.run([args.docker, *parts], capture_output=True, check=True,
                              timeout=timeout, **kwargs).stdout
    def inspect(identifier):
        return json.loads(d('inspect', identifier))[0]
    try:
        state = json.loads(d('image', 'inspect', args.image))[0]
        assert state['Id'] == args.image
        assert 'ARCHON_BUILD_SHA='+args.expected_sha in state['Config']['Env']
        if artifact_mode:
            assert 'TEETIME_AUTH_ARTIFACT_SOURCE_SHA='+args.artifact_source in state['Config']['Env']
        if diagnostic_mode:
            assert 'TEETIME_AUTH_ARTIFACT_SOURCE_SHA='+args.diagnostic_source in state['Config']['Env']
        profile = root/'codex-probe-seccomp.json'
        candidate = json.loads(profile.read_text())
        baseline = json.loads((root/'moby-default-seccomp.json').read_text())
        inventory = json.loads((root/'codex-probe-minimization.json').read_text())
        assert len(inventory) == 12 and all(item['removed'] is False for item in inventory)
        assert candidate == {**baseline, 'syscalls': baseline['syscalls']+[i['rule'] for i in inventory]}
        internal = d('network', 'create', '--internal', '--label', 'teetime.owner='+owner,
                     owner+'-internal').decode().strip()
        manifest['networks'].append(internal)
        egress = d('network', 'create', '--label', 'teetime.owner='+owner,
                   owner+'-egress').decode().strip()
        manifest['networks'].append(egress)
        for network, expected in [(internal, True), (egress, False)]:
            net = json.loads(d('network', 'inspect', network))[0]
            assert net['Internal'] is expected and net['Labels']['teetime.owner'] == owner
        for role, network in [('gateway', egress), ('worker', internal)]:
            extra = []
            command = ['-I', '-']
            if role == 'gateway':
                extra = ['-i']
                command = gateway_command(args.task, execution is not None)
            if role == 'worker':
                extra = ['--security-opt', 'seccomp='+str(profile)]
                for path, options in worker_tmpfs(readonly_mode).items():
                    extra += ['--tmpfs', path+':'+options]
                command = ['-I', '-c', 'import time; time.sleep('+str(330 if diagnostic_mode else (DEMO_LIMITS['containerSeconds'] if execution else 240))+')']
            identifier = d('create', '--name', owner+'-'+role, '--label', 'teetime.owner='+owner,
                '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt',
                'no-new-privileges:true', '--user', '1001:1001', '--memory', '512m',
                '--memory-swap', '512m', '--cpus', '1', '--pids-limit',
                '128' if role == 'worker' else '64', '--no-healthcheck',
                '--log-driver', 'none', *extra, '--entrypoint', 'python3', args.image, *command).decode().strip()
            ids[role] = identifier
            manifest['containers'].append(identifier)
        d('network', 'connect', '--alias', 'teetime-proxy', internal, ids['gateway'])
        for role, identifier in ids.items():
            info = inspect(identifier); host = info['HostConfig']; config = info['Config']
            assert info['Image'] == args.image and config['User'] == '1001:1001'
            assert host['ReadonlyRootfs'] and not host['Privileged'] and host['CapDrop'] == ['ALL']
            assert not host.get('CapAdd') and not info['Mounts']
            assert not any(host.get(k) for k in ['Binds', 'Devices', 'DeviceRequests', 'PortBindings', 'PidMode'])
            assert host['Memory'] == host['MemorySwap'] == 512*1024**2
            assert host['NanoCpus'] == 1000000000
            assert host['PidsLimit'] == (128 if role == 'worker' else 64)
            assert host['LogConfig']['Type'] == 'none'
            assert config['Labels']['teetime.owner'] == owner and config['Entrypoint'] == ['python3']
            expected_names = {owner+'-internal'} if role == 'worker' else {owner+'-internal', owner+'-egress'}
            assert set(info['NetworkSettings']['Networks']) == expected_names
            if role == 'worker':
                assert config['Cmd'] == ['-I', '-c', 'import time; time.sleep('+str(330 if diagnostic_mode else (DEMO_LIMITS['containerSeconds'] if execution else 240))+')']
                assert len(host['SecurityOpt']) == 2 and 'no-new-privileges:true' in host['SecurityOpt']
                assert json.loads(next(v[8:] for v in host['SecurityOpt'] if v.startswith('seccomp='))) == candidate
                assert host['Tmpfs'] == worker_tmpfs(readonly_mode)
                for path in ['/workspace/.codex', '/workspace/.agents']:
                    assert 'ro' in host['Tmpfs'][path].split(',')
            else:
                assert config['Cmd'] == gateway_command(args.task, execution is not None) and config['OpenStdin'] is True
                assert host['SecurityOpt'] == ['no-new-privileges:true'] and not host.get('Tmpfs')
            d('start', identifier)
            started = inspect(identifier)
            assert started['State']['Running']
            actual_nets = {n['NetworkID'] for n in started['NetworkSettings']['Networks'].values()}
            assert actual_nets == ({internal} if role == 'worker' else {internal, egress})
        # Verify runtime bytes against reviewed operator files before credential delivery.
        hashes = {}
        if readonly_mode:
            image_paths = DIAGNOSTIC_IMAGE_PATHS if diagnostic_mode else (*IMAGE_PATHS, 'scripts/staging/teetime_connect_proxy.py')
            measured = d('exec', ids['worker'], 'sha256sum', *['/app/'+path for path in image_paths]).decode()
            actual = {line.split()[1].removeprefix('/app/'): line.split()[0] for line in measured.splitlines()}
            assert actual == {path: frozen_hashes[path] for path in image_paths}
            hashes = frozen_hashes
        else:
            for filename in ['teetime_auth_receiver.py', 'teetime_canary_worker.py', 'teetime-canary-task.ts', 'teetime-canary-result.ts',
                             'teetime_connect_proxy.py']:
                expected = hashlib.sha256(proxy_source if filename == 'teetime_connect_proxy.py' else (root/filename).read_bytes()).hexdigest()
                actual = d('exec', ids['worker'], 'sha256sum', '/app/scripts/staging/'+filename).decode().split()[0]
                assert actual == expected
                hashes[filename] = expected
            for filename in ['run-teetime-auth-canary.py', 'teetime_canary_protocol.py', 'teetime_watchdog.py',
                             'codex-probe-seccomp.json', 'teetime_bounded_process.py', 'teetime_proxy_receipt.py']:
                hashes[filename] = hashlib.sha256((root/filename).read_bytes()).hexdigest()
        startup = bytearray()
        def proxy_output(chunk):
            if not proxy_ready.is_set():
                startup.extend(chunk)
                if b'\n' in startup:
                    first = bytes(startup).split(b'\n', 1)[0]
                    expected_ready = {'proxyReady': True, 'diagnosticVersion': 1} if diagnostic_mode else {'proxyReady': True}
                    actual_ready = strict_json(first) if diagnostic_mode else json.loads(first)
                    if (actual_ready != expected_ready or diagnostic_mode and
                            (actual_ready['proxyReady'] is not True or type(actual_ready['diagnosticVersion']) is not int)):
                        raise ValueError('invalid proxy startup')
                    proxy_ready.set()
        def collect_proxy():
            try:
                proxy_results.put(capture([args.docker,'attach','--sig-proxy=false',ids['gateway']],
                    timeout=min(295, max(.001, controller_deadline-time.monotonic()-5)) if diagnostic_mode else (DEMO_LIMITS['controllerSeconds'] if execution else 205),limit=4096,input_bytes=proxy_source,on_stdout=proxy_output))
            except BaseException:
                proxy_results.put(None)
        proxy_thread = threading.Thread(target=collect_proxy, daemon=True)
        proxy_thread.start()
        assert proxy_ready.wait(6) and inspect(ids['gateway'])['State']['Running']
        # Actual-image masks must deny mutation before any credential exists.
        mask_check = "from pathlib import Path; import subprocess; p=['/workspace/.codex','/workspace/.agents']; assert all(not list(Path(x).iterdir()) for x in p); assert all(subprocess.run(['sh','-c','touch '+x+'/blocked'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0 for x in p)"
        d('exec', ids['worker'], 'python3', '-I', '-c', mask_check)
        if readonly_mode:
            readonly_check = "import sys,json;sys.path.insert(0,'/app/scripts/staging');from teetime_artifact_workspace import require_readonly_workspace;print(json.dumps(require_readonly_workspace('/workspace')))"
            denied = json.loads(d('exec', ids['worker'], 'python3', '-I', '-c', readonly_check))
            assert denied.get('write') == denied.get('create') == 'EROFS' and denied.get('rename') in ['EROFS','EBUSY']
        manifest_path = receipt/'manifest.json'
        manifest_path.write_text(json.dumps(manifest))
        subprocess.Popen([sys.executable, str(root/'teetime_watchdog.py'), '--docker', args.docker,
                          '--manifest', str(manifest_path),*(['--task','supervised-demo'] if execution else [])], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
            creationflags=subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.CREATE_BREAKAWAY_FROM_JOB)
        for _ in range(50):
            if (receipt/'watchdog-ready.json').exists():
                break
            time.sleep(.1)
        ready = json.loads((receipt/'watchdog-ready.json').read_text())
        manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        assert ready['owner'] == owner and ready['deadline'] == manifest['deadline']
        assert ready['manifestSha256'] == manifest_hash and manifest['deadline']-time.time() > (265 if diagnostic_mode else (690 if execution else 170))
        if diagnostic_mode: assert controller_deadline-time.monotonic() > 265
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, ready['pid']); assert handle
        code = ctypes.c_ulong()
        try:
            assert kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
        ready = {'type': 'READY', 'nonce': args.nonce, 'image': args.image,
            'sourceSha': args.expected_sha, 'owner': owner, 'manifestSha256': manifest_hash,
            'workerId': ids['worker'], 'gatewayId': ids['gateway'], 'hashes': hashes}
        if artifact_mode:
            ready.update({'task': args.task, 'artifactSourceSha': args.artifact_source,
                          'artifactContractHash': contract_hash})
        if diagnostic_mode:
            ready.update({'task': args.task, 'diagnosticSourceSha': args.diagnostic_source,
                          'diagnosticContractHash': contract_hash})
            validate_diagnostic_ready(ready, nonce=args.nonce, image=args.image,
                base_source=args.expected_sha, source=args.diagnostic_source, hashes=frozen_hashes)
        print(json.dumps(ready), flush=True)
        announced_ready = ready
        inbox = queue.Queue(maxsize=1)
        def receive():
            try:
                inbox.put(read_frame(sys.stdin.buffer))
            except BaseException:
                inbox.put(None)
        threading.Thread(target=receive, daemon=True).start()
        payload = inbox.get(timeout=10)
        assert payload is not None
        validate_payload(io.BytesIO(payload), time.time())
        installed = json.loads(d('exec', '-i', ids['worker'], 'python3', '-I',
            '/app/scripts/staging/teetime_auth_receiver.py', input=payload, timeout=12))
        del payload
        assert installed == {'installed': True}
        outcome['credentialReceived'] = True
        assert manifest['deadline']-time.time() > (225 if diagnostic_mode else (660 if execution else 145))
        if diagnostic_mode: assert controller_deadline-time.monotonic() > 225
        worker_args = (['--task', args.task, '--nonce', args.nonce, '--artifact-source', args.artifact_source]
                       if artifact_mode else [])
        if execution: worker_args+=['--demo-package-hash',execution.package_hash]
        if diagnostic_mode:
            command, timeout, limit = diagnostic_worker_dispatch(args, ids['worker'])
            returncode, output = capture(command, timeout=timeout, limit=limit)
            if type(returncode) is int and returncode in (0, 1): outcome['workerExitCode'] = returncode
            result = validate_minimal_worker(returncode, output, nonce=args.nonce, source=args.diagnostic_source)
            outcome['workerResult'] = result
            outcome['passed'] = result['passed']
        else:
            returncode, output = capture([args.docker, 'exec', *(['-i'] if execution else []), '-w', '/workspace', ids['worker'],
                'python3', '-I', '/app/scripts/staging/teetime_canary_worker.py', *worker_args],
                timeout=650 if execution else 140,limit=DEMO_LIMITS['protocolLineBytes'] if execution else 4096,
                input_bytes=execution_raw,input_limit=262144 if execution else 65536)
        if not diagnostic_mode and artifact_mode:
            result = strict_json(output)
            validate_worker_result(result, nonce=args.nonce, policy_hash=frozen_hashes[POLICY_PATH],execution=execution)
            assert type(returncode) is int and returncode == (0 if result['passed'] else 1)
            outcome['artifactResult'] = result
            outcome['passed'] = result['passed']
        elif not diagnostic_mode:
            result = json.loads(output)
            keys = {'passed', 'preflightPassed', 'authUnchanged', 'artifactVerified', 'modelInvocations', 'servedModelVerified', 'preflightChecks', 'authenticationRejected', 'taskFailureCode','terminalCount','systemCategory','diagnosticHint','artifactExists','artifactRegular','artifactExactContent','workspaceEntriesExact','exceptionCategory','aborted','elapsedMs','oomKillDelta','taskDiagnosticsPresent'}
            assert set(result) == keys
            assert all(type(result[k]) is bool for k in keys-{'modelInvocations','preflightChecks','taskFailureCode','terminalCount','systemCategory','diagnosticHint','exceptionCategory','elapsedMs','oomKillDelta'})
            assert result['exceptionCategory'] in ['none','aborted','auth_hint','quota_hint','model_access_hint','transport_hint','process_hint','other']
            assert type(result['elapsedMs']) is int and 0 <= result['elapsedMs'] <= 120000
            assert result['oomKillDelta'] is None or type(result['oomKillDelta']) is int and 0 <= result['oomKillDelta'] <= 1024
            assert type(result['terminalCount']) is int and result['terminalCount'] in [0,1]
            assert result['systemCategory'] in ['none','task_list','file_change_failed','file_change_unexpected','format_warning','resume_warning','failback','other']
            assert result['diagnosticHint'] in ['none','permission_hint','sandbox_hint','other']
            assert result['taskFailureCode'] in ['not_started','worker_error','none','unexpected_system','terminal_rejected','provider_failed']
            assert type(result['preflightChecks']) is int and 0 <= result['preflightChecks'] <= 6
            assert type(result['modelInvocations']) is int and result['modelInvocations'] in [0, 1]
            outcome.update(result)
            assert returncode == 0 and result['passed']
    except BaseException:
        outcome['passed'] = False
    finally:
        if proxy_thread is not None:
            try:
                info = inspect(ids['gateway'])
                assert info['Config']['Labels']['teetime.owner'] == owner
                if info['State']['Running']:
                    d('kill','--signal','SIGINT',ids['gateway'])
                captured = proxy_results.get(timeout=max(.001, min(8, controller_deadline-time.monotonic())) if diagnostic_mode else 8)
                assert captured is not None and captured[0] == 0
                proxy_metrics = parse_proxy_diagnostic_receipt(captured[1]) if diagnostic_mode else parse_proxy_receipt(captured[1])
                outcome['proxyMetricsVerified'] = True
            except BaseException:
                outcome['passed'] = False
        outcome['passed'] = outcome['passed'] and outcome['proxyMetricsVerified']
        if diagnostic_mode:
            errors = []
            try:
                errors = cleanup(args.docker, manifest, deadline=controller_deadline)
                # Include resources whose create response was lost, without
                # inventing IDs or declaring an empty known-ID list sufficient.
                for kind in ['container', 'network']:
                    remaining = d(kind, 'ls', '--quiet', '--no-trunc', *(['--all'] if kind == 'container' else []),
                                  '--filter', 'label=teetime.owner='+owner)
                    if remaining.strip(): errors.append({'kind': kind, 'id': None, 'failure': 'OwnershipUncertain'})
            except BaseException:
                errors.append({'kind': 'capture', 'id': ids.get('gateway'), 'failure': 'UnknownFailure'})
        else:
            errors = cleanup(args.docker, manifest)
        if proxy_thread is not None:
            proxy_thread.join(timeout=max(0, min(3, controller_deadline-time.monotonic())) if diagnostic_mode else 3)
            if proxy_thread.is_alive():
                errors.append({'kind':'capture','id':ids['gateway'],'failure':'ThreadAlive'})
                if diagnostic_mode:
                    outcome['proxyMetricsVerified'] = False
                    proxy_metrics = None
        if diagnostic_mode: errors = sanitize_cleanup_errors(errors)
        outcome['cleanupVerified'] = not errors
        outcome['passed'] = outcome['passed'] and not errors
        if artifact_mode and not outcome['passed']:
            outcome['artifactResult'].update({'passed': False, 'artifactVerified': False,
                'artifactBase64': None, 'artifactHash': None, 'bindingHash': None,
                'manifestHash': None, 'sourceTree': None, 'failureCategory': 'rejected'})
        report = {'type': 'RESULT', 'nonce': args.nonce, 'owner': owner,
                  'result': outcome, 'cleanupErrors': errors, 'receiptDirectory': str(receipt), 'proxyMetrics': proxy_metrics}
        if artifact_mode:
            report.update({'task': args.task, 'artifactSourceSha': args.artifact_source,
                           'artifactContractHash': contract_hash})
        if diagnostic_mode:
            report.update({'task': args.task, 'diagnosticSourceSha': args.diagnostic_source,
                           'diagnosticContractHash': contract_hash})
            if announced_ready is not None:
                validate_diagnostic_report(json.dumps(report).encode('ascii'), 0 if outcome['passed'] else 1, ready=announced_ready)
        (receipt/'result.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)
    return 0 if outcome['passed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit(1) from None
