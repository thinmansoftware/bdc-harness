"""Standalone fixed provenance lifecycle. No model, auth, publication or app QA."""
import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe_teetime_snapshot_capture import ControllerHandle, current_creation, guard_controller
from teetime_bounded_process import capture
from teetime_git_objects import build_git_objects
from teetime_materialization_frame import decode_frame, encode_frame
from teetime_snapshot import SnapshotFile, snapshot_manifest
from teetime_artifact_materialization import PreparedMaterialization

ROLES = ('verify', 'writer', 'test')
CASES = ('clean', 'writer-failure', 'forced-writing', 'forced-after-writer')
HELPERS = ('teetime_materializer.py', 'teetime_materialization_check.py',
           'teetime_materialization_frame.py', 'teetime_artifact_contract.py',
           'teetime_snapshot.py', 'teetime_git_objects.py')
ENV = ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'python3', '-I']
INJECTED_WRITER = """import os,sys,time
sys.path.insert(0,'/app/scripts/staging')
from teetime_materializer import materialize
original=os.write
calls=0
def injected(fd,data):
 global calls
 calls+=1
 if calls==1:
  count=original(fd,data[:2]);os.fsync(fd)
  if sys.argv[3]=='forced-writing':time.sleep(60)
  return count
 raise OSError('injected synchronous writer failure')
os.write=injected
try:materialize('/candidate',sys.stdin.buffer.read(65537),expected_manifest_hash=sys.argv[1],expected_tree=sys.argv[2])
except OSError:
 from pathlib import Path
 if Path('/candidate/data.bin').read_bytes()!=b'\\x00\\xff':raise SystemExit(18)
 print('materialization-injected-failure',flush=True);raise SystemExit(17)
raise SystemExit(19)
"""


def validate_manifest(value, now):
    keys = {'owner', 'image', 'source', 'deadline', 'controllerPid', 'controllerCreated'}
    if type(value) is not dict or set(value) != keys:
        raise ValueError('invalid provenance manifest')
    for key, pattern in [('owner', 'teetime-materialize-[a-f0-9]{12}'),
                         ('image', 'sha256:[a-f0-9]{64}'), ('source', '[a-f0-9]{40}'),
                         ('controllerCreated', '(windows|linux):[1-9][0-9]{0,19}')]:
        if type(value[key]) is not str or re.fullmatch(pattern, value[key]) is None:
            raise ValueError('invalid fixed provenance identity')
    if type(value['controllerPid']) is not int or value['controllerPid'] <= 0:
        raise ValueError('invalid provenance controller')
    deadline = value['deadline']
    if type(deadline) not in [int, float] or not math.isfinite(deadline) or not now < deadline <= now+60:
        raise ValueError('invalid provenance deadline')
    return value


def validate_worker(info, manifest, role, command):
    owner = manifest['owner']
    if role not in ROLES:
        raise ValueError('unknown provenance role')
    config, host = info['Config'], info['HostConfig']
    if (info['Name'] != '/'+owner+'-'+role or info['Image'] != manifest['image']
            or config['User'] != '1001:1001' or config.get('Labels', {}).get('teetime.owner') != owner
            or config['Entrypoint'] != ['/usr/bin/env'] or config['Cmd'] != command
            or config['WorkingDir'] != '/tmp' or config.get('Tty', False)
            or config.get('Healthcheck', {}).get('Test') != ['NONE']
            or any(config.get(key) is not True for key in ['OpenStdin', 'StdinOnce', 'AttachStdin'])):
        raise ValueError('fixed provenance worker identity mismatch')
    if (not host['ReadonlyRootfs'] or host['Privileged'] or host['NetworkMode'] != 'none'
            or host['CapDrop'] != ['ALL'] or host['SecurityOpt'] != ['no-new-privileges:true']
            or any(host.get(key) for key in ['Binds', 'Devices', 'DeviceRequests', 'PortBindings', 'PidMode', 'CapAdd'])
            or host['Memory'] != 512*1024**2 or host['MemorySwap'] != 512*1024**2
            or host['NanoCpus'] != 1000000000 or host['PidsLimit'] != 128
            or host['IpcMode'] != 'none' or host['LogConfig']['Type'] != 'none'
            or host['Tmpfs'] != {'/tmp': 'rw,uid=1001,gid=1001,size=64m'}):
        raise ValueError('unsafe provenance runtime controls')
    state = info['State']
    if state['Paused'] or state['OOMKilled'] or state.get('Error'):
        raise ValueError('provenance runtime failure')


def validate_resources(info, volume, references, manifest, role, command):
    if role not in ['writer', 'test']:
        raise ValueError('unknown provenance volume role')
    validate_worker(info, manifest, role, command)
    owner, host = manifest['owner'], info['HostConfig']
    mounts = info['Mounts']
    declared = host.get('Mounts', [])
    if len(mounts) != 1 or len(declared) != 1:
        raise ValueError('exclusive provenance volume required')
    mount, requested = mounts[0], declared[0]
    readonly = role == 'test'
    options = requested.get('VolumeOptions', {})
    if (mount['Type'] != 'volume' or mount['Name'] != owner+'-data'
            or mount['Destination'] != '/candidate' or type(mount['RW']) is not bool or mount['RW'] == readonly
            or mount['Source'] != volume['Mountpoint']
            or mount.get('Driver') != 'local' or mount.get('Propagation', '')
            or requested['Type'] != 'volume' or requested['Source'] != owner+'-data'
            or requested['Target'] != '/candidate' or requested.get('ReadOnly', False) is not readonly
            or type(options) is not dict or set(options)-{'NoCopy'}
            or options.get('NoCopy', False) is not readonly):
        raise ValueError('provenance volume mount mismatch')
    if (volume['Name'] != owner+'-data' or volume['Driver'] != 'local' or volume.get('Scope') != 'local'
            or volume.get('Options') not in [None, {}] or volume.get('Labels') != {'teetime.owner': owner}
            or references != [info['Id']]):
        raise ValueError('foreign volume or remaining writer reference')


def require_state(info, phase, *, expected_exit=0):
    state = info['State']
    if (phase not in ['created', 'running', 'exited'] or state['Status'] != phase
            or state['Running'] is not (phase == 'running') or state['Dead']
            or state['Paused'] or state['OOMKilled'] or state.get('Error')
            or phase != 'running' and state['ExitCode'] != expected_exit):
        raise ValueError('provenance lifecycle state mismatch')


def cleanup(docker, manifest):
    owner = manifest['owner']
    errors = []
    def d(*parts):
        return subprocess.check_output([docker, *parts], stderr=subprocess.DEVNULL, timeout=10)
    for role in ROLES:
        name = owner+'-'+role
        try:
            ids = d('ps', '-aq', '--no-trunc', '--filter', 'name=^/'+name+'$').decode().split()
            if ids:
                if len(ids) != 1:
                    raise ValueError('ambiguous provenance cleanup')
                info = json.loads(d('inspect', ids[0]))[0]
                if (info['Name'] != '/'+name or info['Image'] != manifest['image']
                        or info['Config'].get('Labels', {}).get('teetime.owner') != owner):
                    raise ValueError('foreign provenance cleanup target')
                d('rm', '-f', ids[0])
            if d('ps', '-aq', '--filter', 'name=^/'+name+'$').strip():
                raise ValueError('provenance container remains')
        except Exception as error:
            errors.append(role+':'+type(error).__name__)
    name = owner+'-data'
    try:
        names = d('volume', 'ls', '-q', '--filter', 'name=^'+name+'$').decode().split()
        if names:
            info = json.loads(d('volume', 'inspect', name))[0]
            if (names != [name] or info['Name'] != name or info['Driver'] != 'local'
                    or info.get('Labels') != {'teetime.owner': owner} or info.get('Options') not in [None, {}]
                    or d('ps', '-aq', '--filter', 'volume='+name).strip()):
                raise ValueError('foreign or referenced provenance volume')
            d('volume', 'rm', name)
        if d('volume', 'ls', '-q', '--filter', 'name=^'+name+'$').strip():
            raise ValueError('provenance volume remains')
    except Exception as error:
        errors.append('volume:'+type(error).__name__)
    return errors


def watchdog(args):
    raw = args.manifest.read_bytes()
    if len(raw) > 1024:
        raise ValueError('provenance manifest bound')
    manifest = validate_manifest(json.loads(raw), time.time())
    end = time.monotonic()+manifest['deadline']-time.time()
    parent = ControllerHandle(manifest['controllerPid'], manifest['controllerCreated'])
    try:
        ready = {'owner': manifest['owner'], 'manifestHash': hashlib.sha256(raw).hexdigest(),
                 'pid': os.getpid(), 'controllerPinned': True}
        temporary = args.manifest.parent/'watchdog-ready.tmp'
        temporary.write_text(json.dumps(ready))
        temporary.replace(args.manifest.parent/'watchdog-ready.json')
        while time.monotonic() < end and parent.alive():
            time.sleep(min(.1, max(0, end-time.monotonic())))
        parent.stop()
        absent = 0
        errors = []
        for _ in range(5):
            errors = cleanup(args.docker, manifest)
            absent = 0 if errors else absent+1
            if absent == 2:
                break
            time.sleep(.2)
        verified = absent == 2 and not errors and not parent.alive()
        (args.manifest.parent/'watchdog-result.json').write_text(json.dumps({
            'owner': manifest['owner'], 'cleanupVerified': verified,
            'controllerExited': not parent.alive(), 'errors': errors}))
        return int(not verified)
    finally:
        parent.close()


def test_process_evidence(code, container_code, output):
    if (type(code) is not int or code != 0 or type(container_code) is not int or container_code != 0
            or type(output) is not bytes or len(output) > 4096):
        raise ValueError('normal bounded test process required')
    return {'testExitCode': code, 'testContainerExitCode': container_code,
        'testStdoutBase64': base64.b64encode(output).decode('ascii'),
        'testStdoutHash': hashlib.sha256(output).hexdigest(), 'testCompleted': True,
        'testTruncated': False, 'testTermination': 'normal'}


def run(args, *, prepared=None, sdk_evidence=None):
    files = (SnapshotFile('data.bin', '100644', b'\x00\xffbinary'),
             SnapshotFile('index.html', '100644', b'<p>synthetic-artifact-ready</p>\n'),
             SnapshotFile('src/run.sh', '100755', b'#!/bin/sh\nexit 0\n'))
    digest = hashlib.sha256(snapshot_manifest(files).encode('ascii')).hexdigest()
    tree = build_git_objects(files, expected_format='sha1').root_tree
    ids = {'expected_manifest_hash': digest, 'expected_tree': tree}
    raw = encode_frame(files, **ids)
    if prepared is not None:
        if type(prepared) is not PreparedMaterialization or type(sdk_evidence) is not dict or args.case != 'clean':
            raise ValueError('fixed joined provenance input required')
        raw = prepared.frame
        digest, tree = prepared.manifest_hash, prepared.source_tree
        ids = {'expected_manifest_hash': digest, 'expected_tree': tree}
        files = decode_frame(raw, **ids)
    elif sdk_evidence is not None:
        raise ValueError('SDK evidence requires its prepared candidate')
    if len(raw) > 65536 or decode_frame(raw, **ids) != files:
        raise ValueError('fixed transport bound or candidate validation')
    manifest = validate_manifest({'owner': 'teetime-materialize-'+uuid.uuid4().hex[:12],
        'image': args.image, 'source': args.source, 'controllerPid': os.getpid(),
        'controllerCreated': current_creation(), 'deadline': time.time()+45}, time.time())
    cutoff = time.monotonic()+25
    owner = manifest['owner']
    root = Path.home()/owner
    root.mkdir(exist_ok=False)
    manifest_path = root/'manifest.json'
    manifest_path.write_text(json.dumps(manifest))
    flags = ({'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
              | subprocess.CREATE_BREAKAWAY_FROM_JOB} if os.name == 'nt' else {'start_new_session': True})
    dog = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--docker', args.docker,
        '--watchdog', '--manifest', str(manifest_path)], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, **flags)
    def d(*parts):
        guard_controller(dog, cutoff, time.monotonic())
        return subprocess.check_output([args.docker, *parts], stderr=subprocess.DEVNULL, timeout=8)
    def inspect(kind, name):
        return json.loads(d(kind, 'inspect', name))[0]
    def create(role, command, mounted):
        mounts = (['--mount', 'type=volume,source='+owner+'-data,destination=/candidate'+
                   (',readonly,volume-nocopy' if role == 'test' else '')] if mounted else [])
        return d('create', '-i', '--name', owner+'-'+role, '--label', 'teetime.owner='+owner,
            '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt',
            'no-new-privileges:true', '--user', '1001:1001', '--memory', '512m',
            '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128', '--ipc', 'none',
            '--no-healthcheck', '--log-driver', 'none', '--workdir', '/tmp',
            '--tmpfs', '/tmp:rw,uid=1001,gid=1001,size=64m', *mounts,
            '--entrypoint', '/usr/bin/env', args.image, *command).decode().strip()
    outcome = {'owner': owner, 'source': args.source, 'image': args.image, 'case': args.case,
               'kind': 'fixed provenance fixture, not app QA or admission', 'passed': False,
               'manifestHash': digest, 'sourceTree': tree, 'phase': 'watchdog'}
    if sdk_evidence is not None:
        outcome['sdkEvidence'] = sdk_evidence
    try:
        for _ in range(30):
            if (root/'watchdog-ready.json').exists():
                break
            time.sleep(.1)
        ready = json.loads((root/'watchdog-ready.json').read_bytes())
        if ready != {'owner': owner, 'manifestHash': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                      'pid': dog.pid, 'controllerPinned': True} or dog.poll() is not None:
            raise ValueError('provenance watchdog not ready')
        image = inspect('image', args.image)
        if image['Id'] != args.image or 'TEETIME_MATERIALIZATION_SOURCE_SHA='+args.source not in image['Config']['Env']:
            raise ValueError('provenance image source mismatch')
        outcome['phase'] = 'verify-image'
        expected = {name: hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest() for name in HELPERS}
        check = ("import hashlib,json,os,stat;from pathlib import Path;p=Path('/candidate');s=p.lstat();"
                 "assert stat.S_ISDIR(s.st_mode) and s.st_uid==1001 and not list(p.iterdir());"
                 "print(json.dumps({n:hashlib.sha256(Path('/app/scripts/staging',n).read_bytes()).hexdigest() for n in "+repr(HELPERS)+"}))")
        verify_command = ENV+['-c', check]
        verifier = create('verify', verify_command, False)
        verifier_info = inspect('container', verifier)
        validate_worker(verifier_info, manifest, 'verify', verify_command)
        require_state(verifier_info, 'created')
        if verifier_info['Mounts'] or verifier_info['HostConfig'].get('Mounts'):
            raise ValueError('provenance verifier identity mismatch')
        guard_controller(dog, cutoff, time.monotonic())
        code, output = capture([args.docker, 'start', '--attach', verifier], 8, limit=4096)
        finished = inspect('container', verifier)
        require_state(finished, 'exited', expected_exit=0)
        state = finished['State']
        if code != 0 or state['Running'] or state['ExitCode'] != 0 or state['OOMKilled'] or state.get('Error') or json.loads(output) != expected:
            raise ValueError('immutable provenance helpers or empty image root mismatch')
        d('rm', verifier)
        volume = owner+'-data'
        if d('volume', 'ls', '-q', '--filter', 'name=^'+volume+'$').strip():
            raise ValueError('provenance volume must be new')
        d('volume', 'create', '--driver', 'local', '--label', 'teetime.owner='+owner, volume)
        common = ['--manifest-hash', digest, '--source-tree', tree]
        writer_command = ENV+['/app/scripts/staging/teetime_materializer.py', *common]
        if args.case in ['writer-failure', 'forced-writing']:
            writer_command = ENV+['-c', INJECTED_WRITER, digest, tree, args.case]
        writer = create('writer', writer_command, True)
        def validate(identifier, role, command):
            info = inspect('container', identifier)
            validate_resources(info, inspect('volume', volume),
                d('ps', '-aq', '--no-trunc', '--filter', 'volume='+volume).decode().split(), manifest, role, command)
            return info
        require_state(validate(writer, 'writer', writer_command), 'created')
        d('start', writer)
        require_state(validate(writer, 'writer', writer_command), 'running')
        empty = ("import os,stat;from pathlib import Path;p=Path('/candidate');s=p.lstat();"
                 "assert stat.S_ISDIR(s.st_mode) and s.st_uid==1001 and not list(p.iterdir());print('root-ready')")
        if d('exec', writer, '/usr/bin/env', *ENV, '-c', empty).strip() != b'root-ready':
            raise ValueError('actual new volume root verification failed')
        outcome['phase'] = 'writing'
        guard_controller(dog, cutoff, time.monotonic())
        if args.case == 'forced-writing':
            try:
                capture([args.docker, 'attach', '--sig-proxy=false', writer], 2, limit=4096, input_bytes=raw)
            except (TimeoutError, queue.Empty):
                pass
            else:
                raise ValueError('injected slow writer unexpectedly completed')
            require_state(validate(writer, 'writer', writer_command), 'running')
            probe = "from pathlib import Path;assert Path('/candidate/data.bin').read_bytes()==b'\\x00\\xff';print('partial-writer-confirmed')"
            if d('exec', writer, '/usr/bin/env', *ENV, '-c', probe).strip() != b'partial-writer-confirmed':
                raise ValueError('partial writer not observed')
            (root/'forced-exit.json').write_text(json.dumps({'phase': 'writing', 'partialVerified': True}))
            os._exit(73)
        code, output = capture([args.docker, 'attach', '--sig-proxy=false', writer], 8, limit=4096, input_bytes=raw)
        info = validate(writer, 'writer', writer_command)
        expected_exit = 17 if args.case == 'writer-failure' else 0
        require_state(info, 'exited', expected_exit=expected_exit)
        expected_output = b'materialization-injected-failure\n' if expected_exit else b'materialization-complete\n'
        if code != expected_exit or info['State']['Running'] or info['State']['ExitCode'] != expected_exit or output != expected_output:
            raise ValueError('writer process or completion mismatch')
        outcome['writerExitCode'] = code
        d('rm', writer)
        if d('ps', '-aq', '--filter', 'volume='+volume).strip():
            raise ValueError('writer removal or zero references unverified')
        outcome['writerRemovedBeforeTesting'] = True
        outcome['phase'] = 'writer-removed'
        if args.case == 'writer-failure':
            outcome.update({'passed': True, 'expectedWriterFailure': True, 'testStarted': False})
            return outcome, root
        if args.case == 'forced-after-writer':
            (root/'forced-exit.json').write_text(json.dumps({'phase': 'writer-removed', 'zeroReferencesVerified': True}))
            os._exit(73)
        test_command = ENV+['/app/scripts/staging/teetime_materialization_check.py', *common]
        tester = create('test', test_command, True)
        require_state(validate(tester, 'test', test_command), 'created')
        d('start', tester)
        require_state(validate(tester, 'test', test_command), 'running')
        outcome['phase'] = 'readonly-test'
        guard_controller(dog, cutoff, time.monotonic())
        code, output = capture([args.docker, 'attach', '--sig-proxy=false', tester], 8, limit=4096, input_bytes=raw)
        info = validate(tester, 'test', test_command)
        require_state(info, 'exited', expected_exit=0)
        expected_result = {'commandId': 'teetime-materialization-provenance-v1',
            'helperSha256': expected['teetime_materialization_check.py'], 'beforeManifestHash': digest,
            'afterManifestHash': digest, 'beforeTree': tree, 'afterTree': tree,
            'readonlyDenial': 'EROFS', 'fixtureAssertions': True}
        if (code != 0 or info['State']['Running'] or info['State']['ExitCode'] != 0
                or json.loads(output) != expected_result):
            raise ValueError('fixed readonly test process or receipt mismatch')
        outcome.update(test_process_evidence(code, info['State']['ExitCode'], output))
        outcome.update({'passed': True, 'testStarted': True, 'testReceipt': json.loads(output),
            'testCommandHash': hashlib.sha256(json.dumps(test_command, separators=(',', ':')).encode()).hexdigest(),
            'helperHashes': expected, 'phase': 'complete'})
    except Exception as error:
        outcome['failureCategory'] = type(error).__name__
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
    if not __debug__:
        raise SystemExit('assertion-enabled Python required')
    if args.watchdog:
        raise SystemExit(watchdog(args))
    outcome, root = run(args)
    print(json.dumps({'result': outcome, 'receiptDirectory': str(root)}))
    raise SystemExit(int(not outcome['passed']))
