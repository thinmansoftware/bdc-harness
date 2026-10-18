"""Run only synthetic filesystem operations in an owned, no-network worker."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid
from teetime_bounded_process import capture

parser = argparse.ArgumentParser()
parser.add_argument('--docker',required=True)
parser.add_argument('--image',required=True)
parser.add_argument('--expected-sha',required=True)
parser.add_argument('--patch-fixture',action='store_true')
parser.add_argument('--pids-budget',type=int,choices=[64,128],default=64)
args = parser.parse_args()
if not __debug__:
    raise RuntimeError('assertion-enabled Python required')
assert re.fullmatch('sha256:[a-f0-9]{64}',args.image)
assert re.fullmatch('[a-f0-9]{40}',args.expected_sha)
root = Path(__file__).parent
source = (root/('probe-teetime-patch-fixture-worker.py' if args.patch_fixture else
                'probe-teetime-filesystem-worker.py')).read_bytes()
compile(source,'filesystem-probe','exec')
assert len(source) < 65536 and source.isascii()
name = 'teetime-fs-'+uuid.uuid4().hex[:12]
receipt = Path.home()/name
receipt.mkdir(exist_ok=False)
created = False
diagnostic_passed = False

def d(*parts):
    return subprocess.check_output([args.docker,*parts],timeout=30)

try:
    image = json.loads(d('image','inspect',args.image))[0]
    assert image['Id'] == args.image and 'ARCHON_BUILD_SHA='+args.expected_sha in image['Config']['Env']
    profile = root/'codex-probe-seccomp.json'
    baseline = json.loads((root/'moby-default-seccomp.json').read_bytes())
    inventory = json.loads((root/'codex-probe-minimization.json').read_bytes())
    assert len(inventory) == 12 and all(item['removed'] is False for item in inventory)
    assert json.loads(profile.read_bytes()) == {**baseline,'syscalls':baseline['syscalls']+[item['rule'] for item in inventory]}
    extra = []
    for path in ['/home/appuser','/workspace','/tmp']:
        extra += ['--tmpfs',path+':uid=1001,gid=1001,size=64m']
    for path in ['/workspace/.codex','/workspace/.agents']:
        extra += ['--tmpfs',path+':ro,uid=1001,gid=1001,size=1m']
    identifier = d('create','-i','--name',name,'--label','teetime.owner='+name,
        '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
        '--security-opt','seccomp='+str(profile),'--user','1001:1001','--memory','512m',
        '--memory-swap','512m','--cpus','1','--pids-limit',str(args.pids_budget),'--no-healthcheck',
        '--log-driver','none',*extra,'--entrypoint','python3',args.image,'-I','-').decode().strip()
    created = True
    state = json.loads(d('inspect',identifier))[0]
    host = state['HostConfig']
    assert state['Image'] == args.image and state['Config']['User'] == '1001:1001'
    assert state['Config']['Labels']['teetime.owner'] == name
    assert state['Config']['Entrypoint'] == ['python3'] and state['Config']['Cmd'] == ['-I','-']
    assert state['Config']['OpenStdin'] is True and state['Config']['StdinOnce'] is True
    assert state['Config']['AttachStdin'] is True
    assert host['ReadonlyRootfs'] and not host['Privileged'] and host['NetworkMode'] == 'none'
    assert host['CapDrop'] == ['ALL'] and not host.get('CapAdd') and not state['Mounts']
    assert not any(host.get(key) for key in ['Binds','Devices','DeviceRequests','PortBindings','PidMode'])
    assert host['Memory'] == host['MemorySwap'] == 512*1024**2
    assert host['NanoCpus'] == 1000000000 and host['PidsLimit'] == args.pids_budget
    assert host['LogConfig']['Type'] == 'none'
    assert len(host['SecurityOpt']) == 2 and 'no-new-privileges:true' in host['SecurityOpt']
    assert json.loads(next(value[8:] for value in host['SecurityOpt'] if value.startswith('seccomp='))) == json.loads(profile.read_bytes())
    assert set(host['Tmpfs']) == {'/home/appuser','/workspace','/tmp','/workspace/.codex','/workspace/.agents'}
    for path in ['/workspace/.codex','/workspace/.agents']:
        assert 'ro' in host['Tmpfs'][path].split(',')
    d('start',identifier)
    assert json.loads(d('inspect',identifier))[0]['State']['Running'] is True
    code, output = capture([args.docker,'attach','--sig-proxy=false',identifier],100,
                           limit=65536,input_bytes=source)
    final_state = json.loads(d('inspect',identifier))[0]['State']
    execution_ok = code == 0 and final_state['Running'] is False and final_state['ExitCode'] == 0
    if not execution_ok:
        (receipt/'execution-failure.json').write_text(json.dumps({'attachExitCode':code,
            'containerRunning':final_state['Running'],'containerExitCode':final_state['ExitCode'],
            'boundedSyntheticStdout':output.decode('utf-8',errors='replace')}))
    assert execution_ok, 'synthetic probe process failed; diagnostic failure retained'
    try:
        result = json.loads(output)
    except (ValueError,UnicodeError):
        (receipt/'protocol-failure.txt').write_bytes(output)
        raise RuntimeError('synthetic probe JSON failed; diagnostic failure retained') from None
    diagnostic_passed = result['diagnosticPassed'] is True
    report = {'imageId':args.image,'sourceSha':args.expected_sha,
              'probeSha256':hashlib.sha256(source).hexdigest(),'pidsLimit':args.pids_budget,'result':result}
    (receipt/'result.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))
finally:
    if created:
        state = json.loads(d('inspect',identifier))[0]
        assert state['Config']['Labels']['teetime.owner'] == name
        d('rm','-f',identifier)
        assert identifier not in d('container','ls','--all','--quiet','--no-trunc','--filter','id='+identifier).decode().split()
    print(json.dumps({'receiptDirectory':str(receipt),'cleanupVerified':True}))
if not diagnostic_passed:
    raise SystemExit(1)
