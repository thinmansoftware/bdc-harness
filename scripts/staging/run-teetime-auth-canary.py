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
from teetime_auth_receiver import validate_payload
from teetime_canary_protocol import read_frame
from teetime_watchdog import cleanup
from teetime_bounded_process import capture


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--docker', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--nonce', required=True)
    args = parser.parse_args()
    if os.name != 'nt' or not __debug__:
        raise ValueError('Windows assertion-enabled controller required')
    assert re.fullmatch('sha256:[a-f0-9]{64}', args.image)
    assert re.fullmatch('[a-f0-9]{40}', args.expected_sha)
    assert re.fullmatch('[a-f0-9]{32}', args.nonce)
    root = Path(__file__).parent
    owner = 'teetime-auth-' + uuid.uuid4().hex[:12]
    receipt = Path.home()/owner
    receipt.mkdir(exist_ok=False)
    manifest = {'owner': owner, 'deadline': time.time()+210, 'containers': [], 'networks': []}
    outcome = {'passed': False, 'cleanupVerified': False, 'credentialReceived': False,
               'preflightPassed': False, 'authUnchanged': False, 'artifactVerified': False,
               'modelInvocations': 0, 'servedModelVerified': False, 'preflightChecks': 0,
               'authenticationRejected': False, 'taskFailureCode': 'not_started'}
    def d(*parts, **kwargs):
        return subprocess.run([args.docker, *parts], capture_output=True, check=True,
                              timeout=kwargs.pop('timeout', 15), **kwargs).stdout
    def inspect(identifier):
        return json.loads(d('inspect', identifier))[0]
    try:
        state = json.loads(d('image', 'inspect', args.image))[0]
        assert state['Id'] == args.image
        assert 'ARCHON_BUILD_SHA='+args.expected_sha in state['Config']['Env']
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
        ids = {}
        for role, network in [('gateway', egress), ('worker', internal)]:
            extra = []
            command = ['-I', '/app/scripts/staging/teetime_connect_proxy.py']
            if role == 'worker':
                extra = ['--security-opt', 'seccomp='+str(profile)]
                for path in ['/home/appuser', '/workspace', '/tmp']:
                    extra += ['--tmpfs', path+':uid=1001,gid=1001,size=64m']
                for path in ['/workspace/.codex', '/workspace/.agents']:
                    extra += ['--tmpfs', path+':ro,uid=1001,gid=1001,size=1m']
                command = ['-I', '-c', 'import time; time.sleep(240)']
            identifier = d('create', '--name', owner+'-'+role, '--label', 'teetime.owner='+owner,
                '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt',
                'no-new-privileges:true', '--user', '1001:1001', '--memory', '512m',
                '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64', '--no-healthcheck',
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
            assert host['NanoCpus'] == 1000000000 and host['PidsLimit'] == 64
            assert host['LogConfig']['Type'] == 'none'
            assert config['Labels']['teetime.owner'] == owner and config['Entrypoint'] == ['python3']
            expected_names = {owner+'-internal'} if role == 'worker' else {owner+'-internal', owner+'-egress'}
            assert set(info['NetworkSettings']['Networks']) == expected_names
            if role == 'worker':
                assert config['Cmd'] == ['-I', '-c', 'import time; time.sleep(240)']
                assert len(host['SecurityOpt']) == 2 and 'no-new-privileges:true' in host['SecurityOpt']
                assert json.loads(next(v[8:] for v in host['SecurityOpt'] if v.startswith('seccomp='))) == candidate
                assert set(host['Tmpfs']) == {'/home/appuser', '/workspace', '/tmp', '/workspace/.codex', '/workspace/.agents'}
                for path in ['/workspace/.codex', '/workspace/.agents']:
                    assert 'ro' in host['Tmpfs'][path].split(',')
            else:
                assert config['Cmd'] == ['-I', '/app/scripts/staging/teetime_connect_proxy.py']
                assert host['SecurityOpt'] == ['no-new-privileges:true'] and not host.get('Tmpfs')
            d('start', identifier)
            started = inspect(identifier)
            assert started['State']['Running']
            actual_nets = {n['NetworkID'] for n in started['NetworkSettings']['Networks'].values()}
            assert actual_nets == ({internal} if role == 'worker' else {internal, egress})
        # Verify runtime bytes against reviewed operator files before credential delivery.
        hashes = {}
        for filename in ['teetime_auth_receiver.py', 'teetime_canary_worker.py', 'teetime-canary-task.ts', 'teetime-canary-result.ts',
                         'teetime_connect_proxy.py']:
            expected = hashlib.sha256((root/filename).read_bytes()).hexdigest()
            actual = d('exec', ids['worker'], 'sha256sum', '/app/scripts/staging/'+filename).decode().split()[0]
            assert actual == expected
            hashes[filename] = expected
        for filename in ['run-teetime-auth-canary.py', 'teetime_canary_protocol.py', 'teetime_watchdog.py',
                         'codex-probe-seccomp.json', 'teetime_bounded_process.py']:
            hashes[filename] = hashlib.sha256((root/filename).read_bytes()).hexdigest()
        # Actual-image masks must deny mutation before any credential exists.
        mask_check = "from pathlib import Path; import subprocess; p=['/workspace/.codex','/workspace/.agents']; assert all(not list(Path(x).iterdir()) for x in p); assert all(subprocess.run(['sh','-c','touch '+x+'/blocked'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0 for x in p)"
        d('exec', ids['worker'], 'python3', '-I', '-c', mask_check)
        manifest_path = receipt/'manifest.json'
        manifest_path.write_text(json.dumps(manifest))
        subprocess.Popen([sys.executable, str(root/'teetime_watchdog.py'), '--docker', args.docker,
                          '--manifest', str(manifest_path)], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
            creationflags=subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.CREATE_BREAKAWAY_FROM_JOB)
        for _ in range(50):
            if (receipt/'watchdog-ready.json').exists():
                break
            time.sleep(.1)
        ready = json.loads((receipt/'watchdog-ready.json').read_text())
        manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        assert ready['owner'] == owner and ready['deadline'] == manifest['deadline']
        assert ready['manifestSha256'] == manifest_hash and manifest['deadline']-time.time() > 170
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
        print(json.dumps({'type': 'READY', 'nonce': args.nonce, 'image': args.image,
            'sourceSha': args.expected_sha, 'owner': owner, 'manifestSha256': manifest_hash,
            'workerId': ids['worker'], 'gatewayId': ids['gateway'], 'hashes': hashes}), flush=True)
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
        assert manifest['deadline']-time.time() > 145
        returncode, output = capture([args.docker, 'exec', '-w', '/workspace', ids['worker'],
            'python3', '-I', '/app/scripts/staging/teetime_canary_worker.py'], timeout=140)
        result = json.loads(output)
        keys = {'passed', 'preflightPassed', 'authUnchanged', 'artifactVerified', 'modelInvocations', 'servedModelVerified', 'preflightChecks', 'authenticationRejected', 'taskFailureCode'}
        assert set(result) == keys
        assert all(type(result[k]) is bool for k in keys-{'modelInvocations','preflightChecks','taskFailureCode'})
        assert result['taskFailureCode'] in ['not_started','worker_error','none','unexpected_system','terminal_rejected','provider_failed']
        assert type(result['preflightChecks']) is int and 0 <= result['preflightChecks'] <= 6
        assert type(result['modelInvocations']) is int and result['modelInvocations'] in [0, 1]
        outcome.update(result)
        assert returncode == 0 and result['passed']
    except BaseException:
        outcome['passed'] = False
    finally:
        errors = cleanup(args.docker, manifest)
        outcome['cleanupVerified'] = not errors
        outcome['passed'] = outcome['passed'] and not errors
        report = {'type': 'RESULT', 'nonce': args.nonce, 'owner': owner,
                  'result': outcome, 'cleanupErrors': errors, 'receiptDirectory': str(receipt)}
        (receipt/'result.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report), flush=True)
    return 0 if outcome['passed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit('canary controller failed before setup') from None
