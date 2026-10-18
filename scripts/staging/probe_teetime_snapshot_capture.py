"""Standalone no-auth, synchronous-writer capture qualification; not admission.

An exclusive local volume and paused worker bound this prototype. Previously
submitted asynchronous I/O remains unqualified. No unpause path is implemented.
"""
import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from teetime_bounded_process import capture
from teetime_git_objects import build_git_objects
from teetime_snapshot import read_snapshot, snapshot_manifest
from teetime_snapshot_exporter import FIXTURE_SCOPE, MAX_FRAME, REJECT_MAGIC, canonical, decode_frame

CASES = ('clean', 'shadow', 'symlink', 'hardlink', 'unpaused', 'forced-exit',
         'delayed-create', 'controller-stall')
HELPERS = ('teetime_snapshot.py', 'teetime_git_objects.py', 'teetime_snapshot_exporter.py')
WRITER = """import os,struct,sys,time
from pathlib import Path
p=Path('/workspace')
for name in ['.codex','.agents','src']: (p/name).mkdir(exist_ok=True)
(p/'.gitignore').write_bytes(b'ignored.tmp\\n')
(p/'ignored.tmp').write_bytes(b'ignored binary\\x00')
(p/'src/new.txt').write_bytes(b'new fixture file\\n')
case=sys.argv[1]
if case=='shadow': (p/'.codex/hidden').write_bytes(b'reject')
if case=='symlink':
 (p/'ignored.tmp').unlink(); (p/'ignored.tmp').symlink_to('/etc/passwd')
if case=='hardlink':
 (p/'ignored.tmp').unlink(); os.link(p/'src/new.txt',p/'ignored.tmp')
fd=os.open(p/'counter.txt',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
counter=0
while True:
 counter+=1
 if os.pwrite(fd,struct.pack('!Q',counter),0)!=8: raise SystemExit(2)
 os.fsync(fd)
 time.sleep(.02)
"""


def command_for(role, case):
    prefix = ['-i', 'PATH=/usr/bin:/bin', 'HOME=/tmp', 'python3', '-I']
    return prefix+(['-c', WRITER, case] if role == 'worker' else
                   ['/app/scripts/staging/teetime_snapshot_exporter.py', '--fixture'])


def validate_manifest(value, now):
    if type(value) is not dict or set(value) != {'owner', 'image', 'source', 'deadline',
                                               'controllerPid', 'controllerCreated'}:
        raise ValueError('invalid capture manifest')
    if not re.fullmatch('teetime-capture-[a-f0-9]{12}', str(value['owner'])):
        raise ValueError('invalid capture owner')
    if not re.fullmatch('sha256:[a-f0-9]{64}', str(value['image'])):
        raise ValueError('exact capture image required')
    if not re.fullmatch('[a-f0-9]{40}', str(value['source'])):
        raise ValueError('exact capture source required')
    if type(value['controllerPid']) is not int or value['controllerPid'] <= 0:
        raise ValueError('invalid controller PID')
    if not re.fullmatch('(windows|linux):[1-9][0-9]{0,19}', str(value['controllerCreated'])):
        raise ValueError('invalid controller creation identity')
    if (type(value['deadline']) not in [int, float] or not math.isfinite(value['deadline'])
            or not now < value['deadline'] <= now+60):
        raise ValueError('invalid capture deadline')
    return value


def guard_controller(dog, cutoff, now):
    if dog.poll() is not None or now >= cutoff:
        raise ValueError('controller execution window closed')


def windows_creation(kernel, handle):
    kernel.GetProcessTimes.argtypes = [ctypes.c_void_p]+[ctypes.POINTER(ctypes.c_ulonglong)]*4
    values = [ctypes.c_ulonglong() for _ in range(4)]
    if not kernel.GetProcessTimes(handle, *[ctypes.byref(value) for value in values]):
        raise ValueError('controller creation time unavailable')
    return 'windows:'+str(values[0].value)


def current_creation():
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        return windows_creation(kernel, kernel.GetCurrentProcess())
    return 'linux:'+Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]


def validate_controller_identity(actual, expected):
    if actual != expected:
        raise ValueError('controller creation identity mismatch')


class ControllerHandle:
    """Pin the actual parent process before READY; never signal a reused PID."""
    def __init__(self, pid, created):
        if os.name == 'nt':
            self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            self.kernel.OpenProcess.restype = ctypes.c_void_p
            self.kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            self.kernel.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
            self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            self.handle = self.kernel.OpenProcess(0x100000 | 0x1 | 0x1000, False, pid)
            if not self.handle:
                raise ValueError('controller handle unavailable')
            try:
                validate_controller_identity(windows_creation(self.kernel, self.handle), created)
            except Exception:
                self.close()
                raise
        else:
            if os.getppid() != pid:
                raise ValueError('controller exited before watchdog arm')
            self.handle = os.pidfd_open(pid)
            try:
                stamp = 'linux:'+Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')', 1)[1].split()[19]
                validate_controller_identity(stamp, created)
            except Exception:
                self.close()
                raise
        if not self.alive():
            self.close()
            raise ValueError('controller not alive before watchdog arm')

    def alive(self):
        if os.name == 'nt':
            result = self.kernel.WaitForSingleObject(self.handle, 0)
            if result not in [0, 258]:
                raise ValueError('controller handle wait failed')
            return result == 258
        return not bool(select.select([self.handle], [], [], 0)[0])

    def stop(self):
        if self.alive():
            if os.name == 'nt':
                if not self.kernel.TerminateProcess(self.handle, 74):
                    raise ValueError('controller termination failed')
            else:
                signal.pidfd_send_signal(self.handle, signal.SIGKILL)
        end = time.monotonic()+5
        while self.alive() and time.monotonic() < end:
            time.sleep(.05)
        if self.alive():
            raise ValueError('controller exit not verified')

    def close(self):
        if os.name == 'nt':
            self.kernel.CloseHandle(self.handle)
        else:
            os.close(self.handle)


def validate_resources(worker, exporter, volume, references, manifest, case, paused):
    owner, image = manifest['owner'], manifest['image']
    if (volume['Name'] != owner+'-data' or volume['Driver'] != 'local'
            or volume.get('Options') not in [None, {}] or volume.get('Scope') != 'local'
            or volume.get('Labels', {}).get('teetime.owner') != owner):
        raise ValueError('volume ownership or backing mismatch')
    if set(references) != {worker['Id'], exporter['Id']} or len(references) != 2:
        raise ValueError('volume not exclusively owned')
    for role, info in [('worker', worker), ('exporter', exporter)]:
        config, host = info['Config'], info['HostConfig']
        if (info['Name'] != '/'+owner+'-'+role or info['Image'] != image
                or not re.fullmatch('[a-f0-9]{64}', info['Id'])
                or config.get('Labels', {}).get('teetime.owner') != owner
                or config['User'] != '1001:1001' or config['Entrypoint'] != ['/usr/bin/env']
                or config['Cmd'] != command_for(role, case) or config.get('OpenStdin')
                or config.get('Tty')):
            raise ValueError('capture container identity mismatch')
        if (host['NetworkMode'] != 'none' or not host['ReadonlyRootfs'] or host['Privileged']
                or host['CapDrop'] != ['ALL'] or host.get('CapAdd')
                or host['SecurityOpt'] != ['no-new-privileges:true']
                or host['Memory'] != 128*1024**2 or host['MemorySwap'] != 128*1024**2
                or host['NanoCpus'] != 1000000000 or host['PidsLimit'] != 64
                or host['LogConfig']['Type'] != 'none'
                or host.get('IpcMode') != 'none'
                or any(host.get(key) for key in ['Binds', 'Devices', 'DeviceRequests',
                    'PortBindings', 'PidMode', 'UTSMode', 'UsernsMode'])
                or set(host.get('Tmpfs', {})) != {'/tmp'}
                or host['Tmpfs']['/tmp'] != 'rw,uid=1001,gid=1001,size=8m'):
            raise ValueError('capture isolation mismatch')
        mounts = info['Mounts']
        if len(mounts) != 1:
            raise ValueError('unexpected capture mount')
        mount = mounts[0]
        if (mount['Type'] != 'volume' or mount['Name'] != volume['Name']
                or mount['Source'] != volume['Mountpoint'] or mount['Destination'] != '/workspace'
                or mount['Driver'] != 'local' or mount['RW'] is not (role == 'worker')):
            raise ValueError('capture mount identity mismatch')
    if paused is None:
        if any(info['State']['Running'] or info['State']['Paused'] for info in [worker, exporter]):
            raise ValueError('workload started before configuration validation')
    elif worker['State']['Running'] is not True or worker['State']['Paused'] is not paused:
        raise ValueError('worker execution barrier mismatch')


def validate_verifier(info, manifest):
    host, config = info['HostConfig'], info['Config']
    if (info['Name'] != '/'+manifest['owner']+'-verify' or info['Image'] != manifest['image']
            or config.get('Labels', {}).get('teetime.owner') != manifest['owner']
            or config['Entrypoint'] != ['/usr/bin/sha256sum'] or config['User'] != '1001:1001'
            or config['Cmd'] != ['/app/scripts/staging/'+name for name in HELPERS]
            or info['Mounts'] or info['State']['Running'] or config.get('OpenStdin') or config.get('Tty')
            or host['NetworkMode'] != 'none' or not host['ReadonlyRootfs'] or host['Privileged']
            or host['CapDrop'] != ['ALL'] or host.get('CapAdd')
            or host['SecurityOpt'] != ['no-new-privileges:true']
            or host['Memory'] != 32*1024**2 or host['MemorySwap'] != 32*1024**2
            or host['PidsLimit'] != 16 or host['LogConfig']['Type'] != 'none'
            or any(host.get(key) for key in ['Binds', 'Devices', 'DeviceRequests', 'PortBindings',
                                           'PidMode', 'Tmpfs'])):
        raise ValueError('verifier configuration mismatch')


def cleanup(docker, manifest):
    owner = manifest['owner']
    errors = []
    def d(*parts):
        return subprocess.check_output([docker, *parts], stderr=subprocess.DEVNULL, timeout=10)
    for role in ['verify', 'exporter', 'worker']:
        name = owner+'-'+role
        try:
            ids = d('ps', '-aq', '--no-trunc', '--filter', 'name=^/'+name+'$').decode().split()
            if ids:
                if len(ids) != 1:
                    raise ValueError('ambiguous cleanup identity')
                info = json.loads(d('container', 'inspect', ids[0]))[0]
                if (info['Name'] != '/'+name or info['Image'] != manifest['image']
                        or info['Config'].get('Labels', {}).get('teetime.owner') != owner):
                    raise ValueError('cleanup ownership mismatch')
                d('container', 'rm', '--force', ids[0])
            if d('ps', '-aq', '--filter', 'name=^/'+name+'$').strip():
                raise ValueError('container cleanup not verified')
        except Exception as error:
            errors.append(role+':'+type(error).__name__)
    name = owner+'-data'
    try:
        names = d('volume', 'ls', '-q', '--filter', 'name=^'+name+'$').decode().split()
        if names:
            info = json.loads(d('volume', 'inspect', name))[0]
            if (names != [name] or info['Name'] != name or info['Driver'] != 'local'
                    or info.get('Labels', {}).get('teetime.owner') != owner):
                raise ValueError('volume cleanup ownership mismatch')
            if d('ps', '-aq', '--filter', 'volume='+name).strip():
                raise ValueError('volume still referenced')
            d('volume', 'rm', name)
        if d('volume', 'ls', '-q', '--filter', 'name=^'+name+'$').strip():
            raise ValueError('volume cleanup not verified')
    except Exception as error:
        errors.append('volume:'+type(error).__name__)
    return errors


def watchdog(args):
    raw = args.manifest.read_bytes()
    if len(raw) > 1024:
        raise ValueError('capture manifest bound')
    manifest = validate_manifest(json.loads(raw), time.time())
    deadline = time.monotonic()+manifest['deadline']-time.time()
    parent = ControllerHandle(manifest['controllerPid'], manifest['controllerCreated'])
    try:
        ready = {'owner': manifest['owner'], 'manifestHash': hashlib.sha256(raw).hexdigest(),
                 'pid': os.getpid(), 'controllerPinned': True}
        temporary = args.manifest.parent/'watchdog-ready.tmp'
        temporary.write_text(json.dumps(ready))
        temporary.replace(args.manifest.parent/'watchdog-ready.json')
        while time.monotonic() < deadline and parent.alive():
            time.sleep(min(.1, max(0, deadline-time.monotonic())))
        parent.stop()
        errors = []
        # Parent is verifiably gone, so it cannot start a later Docker operation.
        # Reconcile failures; require multiple successful absence observations.
        absent = 0
        for _ in range(5):
            errors = cleanup(args.docker, manifest)
            absent = 0 if errors else absent+1
            if absent == 2:
                break
            time.sleep(.2)
        verified = not errors and absent == 2 and not parent.alive()
        (args.manifest.parent/'watchdog-result.json').write_text(json.dumps(
            {'owner': manifest['owner'], 'cleanupVerified': verified,
             'controllerExited': not parent.alive(), 'errors': errors}))
        return int(not verified)
    finally:
        parent.close()


def run(args):
    manifest = validate_manifest({'owner': 'teetime-capture-'+uuid.uuid4().hex[:12],
        'image': args.image, 'source': args.source, 'deadline': time.time()+45,
        'controllerPid': os.getpid(), 'controllerCreated': current_creation()}, time.time())
    cutoff = time.monotonic()+25
    owner = manifest['owner']
    root = Path.home()/owner
    root.mkdir()
    manifest_path = root/'manifest.json'
    with manifest_path.open('x') as stream:
        json.dump(manifest, stream)
    flags = ({'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
              | subprocess.CREATE_BREAKAWAY_FROM_JOB} if os.name == 'nt' else {'start_new_session': True})
    dog = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--docker', args.docker,
        '--watchdog', '--manifest', str(manifest_path)], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, **flags)
    def d(*parts):
        guard_controller(dog, cutoff, time.monotonic())
        return subprocess.check_output([args.docker, *parts], stderr=subprocess.DEVNULL, timeout=8)
    def inspect(kind, name):
        return json.loads(d(kind, 'inspect', name))[0]
    outcome = {'kind': 'synchronous writer capture prototype, not admission', 'owner': owner,
               'source': args.source, 'image': args.image, 'case': args.case,
               'passed': False, 'cleanupVerified': False, 'captureVerified': False}
    try:
        for _ in range(30):
            if (root/'watchdog-ready.json').exists():
                break
            time.sleep(.1)
        ready = json.loads((root/'watchdog-ready.json').read_text())
        if (ready != {'owner': owner, 'manifestHash': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                      'pid': dog.pid, 'controllerPinned': True} or dog.poll() is not None):
            raise ValueError('watchdog not ready')
        if args.case == 'delayed-create':
            time.sleep(max(0, cutoff-time.monotonic()+.1))
            try:
                d('volume', 'create', '--driver', 'local', '--label', 'teetime.owner='+owner, owner+'-data')
            except ValueError:
                outcome['expectedRejection'] = True
                outcome['passed'] = True
                return outcome, root
            raise ValueError('late resource creation was allowed')
        image = inspect('image', args.image)
        if (image['Id'] != args.image
                or 'TEETIME_CAPTURE_SOURCE_SHA='+args.source not in image['Config']['Env']):
            raise ValueError('capture image source mismatch')
        verifier = d('create', '--name', owner+'-verify', '--label', 'teetime.owner='+owner,
            '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt',
            'no-new-privileges:true', '--user', '1001:1001', '--no-healthcheck',
            '--memory', '32m', '--memory-swap', '32m', '--pids-limit', '16', '--log-driver', 'none',
            '--entrypoint', '/usr/bin/sha256sum', args.image,
            *['/app/scripts/staging/'+name for name in HELPERS]).decode().strip()
        validate_verifier(inspect('container', verifier), manifest)
        guard_controller(dog, cutoff, time.monotonic())
        code, raw = capture([args.docker, 'start', '--attach', verifier], timeout=8, limit=4096)
        verified_state = inspect('container', verifier)['State']
        actual = {line.split()[1]: line.split()[0] for line in raw.decode('ascii').splitlines()}
        expected = {'/app/scripts/staging/'+name:
            hashlib.sha256((Path(__file__).resolve().parent/name).read_bytes()).hexdigest() for name in HELPERS}
        if code != 0 or verified_state['Running'] or verified_state['ExitCode'] != 0 or actual != expected:
            raise ValueError('immutable exporter source mismatch')
        d('container', 'rm', verifier)
        volume = owner+'-data'
        d('volume', 'create', '--driver', 'local', '--label', 'teetime.owner='+owner, volume)
        ids = {}
        for role in ['worker', 'exporter']:
            mount = 'type=volume,source='+volume+',destination=/workspace'+(',readonly' if role == 'exporter' else '')
            ids[role] = d('create', '--name', owner+'-'+role, '--label', 'teetime.owner='+owner,
                '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt',
                'no-new-privileges:true', '--user', '1001:1001', '--memory', '128m',
                '--memory-swap', '128m', '--cpus', '1', '--pids-limit', '64',
                '--no-healthcheck', '--log-driver', 'none', '--ipc', 'none',
                '--tmpfs', '/tmp:rw,uid=1001,gid=1001,size=8m', '--mount', mount,
                '--entrypoint', '/usr/bin/env', args.image, *command_for(role, args.case)).decode().strip()
        def validate(paused):
            worker = inspect('container', ids['worker'])
            exporter = inspect('container', ids['exporter'])
            references = d('ps', '-aq', '--no-trunc', '--filter', 'volume='+volume).decode().split()
            validate_resources(worker, exporter, inspect('volume', volume), references, manifest, args.case, paused)
            return worker
        validate(None)
        d('start', ids['worker'])
        validate(False)
        check = "from pathlib import Path; import struct,time; p=Path('/workspace/counter.txt'); end=time.monotonic()+3;\nwhile (not p.exists() or p.stat().st_size!=8) and time.monotonic()<end: time.sleep(.02)\na=struct.unpack('!Q',p.read_bytes())[0]; time.sleep(.1); b=struct.unpack('!Q',p.read_bytes())[0]; assert b>a; print(b)"
        pre_pause_counter = int(d('exec', ids['worker'], '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'python3', '-I', '-c', check))
        if args.case != 'unpaused':
            d('pause', ids['worker'])
        if args.case in ['forced-exit', 'controller-stall']:
            validate(True)
            (root/'forced-exit.json').write_text(json.dumps({'owner': owner, 'paused': True, 'case': args.case}))
            if args.case == 'controller-stall':
                time.sleep(60)
            os._exit(73)
        try:
            validate(True)
        except ValueError:
            if args.case != 'unpaused':
                raise
            outcome['expectedRejection'] = True
            outcome['passed'] = True
            return outcome, root
        frames = []
        for _ in range(2):
            validate(True)
            guard_controller(dog, cutoff, time.monotonic())
            status, raw = capture([args.docker, 'start', '--attach', ids['exporter']], timeout=8, limit=MAX_FRAME)
            validate(True)
            state = inspect('container', ids['exporter'])['State']
            if state['Running'] or state['OOMKilled'] or state.get('Error'):
                raise ValueError('export process termination mismatch')
            if args.case in ['shadow', 'symlink', 'hardlink']:
                category = {'shadow': 'shadow', 'symlink': 'entry', 'hardlink': 'scope'}[args.case]
                if status != 2 or state['ExitCode'] != 2 or raw != REJECT_MAGIC+canonical({'rejected': category}):
                    raise ValueError('unsafe fixture was not rejected')
                outcome['expectedRejection'] = True
                outcome['passed'] = True
                return outcome, root
            if status != 0 or state['ExitCode'] != 0:
                raise ValueError('export process failed')
            inventory, archive = decode_frame(raw, FIXTURE_SCOPE)
            if inventory != tuple(sorted(FIXTURE_SCOPE)):
                raise ValueError('fixture inventory mismatch')
            files = read_snapshot(archive, inventory)
            expected = {'.gitignore': b'ignored.tmp\n', 'ignored.tmp': b'ignored binary\x00',
                        'src/new.txt': b'new fixture file\n'}
            for file in files:
                if file.path in expected and file.content != expected[file.path]:
                    raise ValueError('fixture file content mismatch')
                if file.path == 'counter.txt' and (len(file.content) != 8
                        or int.from_bytes(file.content, 'big') < pre_pause_counter):
                    raise ValueError('fixture writer counter mismatch')
            frames.append(raw)
            time.sleep(.15)
        if frames[0] != frames[1]:
            raise ValueError('paused synchronous fixture changed')
        snapshot = snapshot_manifest(files)
        tree = build_git_objects(files, expected_format='sha1')
        outcome.update({'passed': True, 'captureVerified': True, 'writerCounterStable': True,
            'inventory': list(inventory), 'snapshotManifestHash': hashlib.sha256(snapshot.encode()).hexdigest(),
            'sourceTree': tree.root_tree, 'pausedAfterExport': validate(True)['State']['Paused']})
    except Exception as error:
        outcome['failure'] = type(error).__name__
    finally:
        errors = cleanup(args.docker, manifest)
        outcome['cleanupVerified'] = not errors
        outcome['cleanupErrors'] = errors
        outcome['passed'] = outcome['passed'] and not errors
        (root/'result.json').write_text(json.dumps(outcome, sort_keys=True))
    return outcome, root


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--docker', required=True)
    parser.add_argument('--image')
    parser.add_argument('--source')
    parser.add_argument('--case', choices=CASES, default='clean')
    parser.add_argument('--watchdog', action='store_true')
    parser.add_argument('--manifest', type=Path)
    args = parser.parse_args()
    try:
        if args.watchdog:
            raise SystemExit(watchdog(args))
        result, root = run(args)
        print(json.dumps({'receiptDirectory': str(root), **result}, sort_keys=True))
        raise SystemExit(0 if result['passed'] else 1)
    except Exception:
        raise SystemExit('capture prototype failed before execution') from None
