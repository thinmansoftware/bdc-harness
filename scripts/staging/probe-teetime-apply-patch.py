"""No-auth apply-patch reproduction through the already qualified named sandbox."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--docker', required=True)
parser.add_argument('--image', required=True)
parser.add_argument('--expected-sha', required=True)
args = parser.parse_args()
if not __debug__:
    raise SystemExit('Assertions required')
name = 'teetime-patch-'+uuid.uuid4().hex[:12]
created = False
receipt = Path.home()/name
receipt.mkdir()


def d(*parts, **kwargs):
    return subprocess.run([args.docker,*parts], capture_output=True, check=True,
                          timeout=30, **kwargs).stdout


try:
    image = json.loads(d('image','inspect',args.image))[0]
    assert image['Id'] == args.image and 'ARCHON_BUILD_SHA='+args.expected_sha in image['Config']['Env']
    profile = Path(__file__).with_name('codex-probe-seccomp.json')
    extra = ['--security-opt','seccomp='+str(profile)]
    for path in ['/home/appuser','/workspace','/tmp']:
        extra += ['--tmpfs',path+':uid=1001,gid=1001,size=64m']
    for path in ['/workspace/.codex','/workspace/.agents']:
        extra += ['--tmpfs',path+':ro,uid=1001,gid=1001,size=1m']
    identifier = d('create','-i','--name',name,'--label','teetime.owner='+name,
        '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
        '--user','1001:1001','--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','64',
        '--no-healthcheck','--log-driver','none',*extra,'--entrypoint','python3',args.image,'-I','-').decode().strip()
    created = True
    info = json.loads(d('inspect',identifier))[0]; host = info['HostConfig']
    assert info['Image'] == args.image and info['Config']['User'] == '1001:1001'
    assert host['ReadonlyRootfs'] and not host['Privileged'] and host['CapDrop'] == ['ALL']
    assert host['NetworkMode'] == 'none' and not info['Mounts'] and not host.get('Binds')
    assert json.loads(next(s[8:] for s in host['SecurityOpt'] if s.startswith('seccomp='))) == json.loads(profile.read_text())
    code = r'''
import json,os,subprocess
from pathlib import Path
binary='/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
env={'HOME':'/home/appuser','CODEX_HOME':'/home/appuser/.codex','PATH':'/usr/local/bin:/usr/bin:/bin'}
assert subprocess.check_output([binary,'--version'],env=env).strip()==b'codex-cli 0.153.3'
home=Path('/home/appuser/.codex'); assert not home.exists(); home.mkdir(mode=0o700)
home.joinpath('config.toml').write_text('''+repr('approval_policy = "never"\n[permissions.tee-time]\nextends = ":workspace"\n[permissions.tee-time.filesystem]\n":root" = "deny"\n":minimal" = "read"\n"/app" = "read"\n":slash_tmp" = "deny"\n":tmpdir" = "deny"\n[permissions.tee-time.network]\nenabled = false\n')+r''')
assert not home.joinpath('auth.json').exists()
os.chdir('/workspace')
policy=json.loads(subprocess.check_output(['bun','-e','import {restrictedClientOptions} from "/app/packages/providers/src/codex/restricted-policy.ts"; console.log(JSON.stringify(restrictedClientOptions("teetime-connect-v1")))'],env=env))
overrides=[]
def flatten(value,prefix=''):
 for key,item in value.items():
  path=prefix+'.'+key if prefix else key
  if isinstance(item,dict): flatten(item,path)
  else: overrides.extend(['-c',path+'='+json.dumps(item,separators=(',',':'))])
flatten(policy['config'])
for value in policy['configOverrides']: overrides.extend(['-c',value])
sandbox=[binary,*overrides,'sandbox','-P','tee-time','-C','/workspace','sh','-c','printf "sandbox-command-started\n"; exec "$@"','probe']
patch='*** Begin Patch\n*** Add File: /workspace/canary.txt\n+tee-time-canary-ready\n*** End Patch\n'
result=subprocess.run([*sandbox,binary,'--codex-run-as-apply-patch',patch],env=env,capture_output=True,timeout=10)
assert b'sandbox-command-started\n' in result.stdout
assert result.returncode==0, 'workspace patch failed: '+result.stderr.decode()
assert Path('/workspace/canary.txt').read_bytes()==b'tee-time-canary-ready\n'
controls={}
for key,path in [('home','/home/appuser/shell-outside.txt'),('tmp','/tmp/shell-outside.txt')]:
 control=subprocess.run([*sandbox,'sh','-c','printf synthetic-control > '+path],env=env,capture_output=True,timeout=10)
 controls[key+'ShellExitCode']=control.returncode
 controls[key+'ShellFileExists']=Path(path).exists()
home.joinpath('auth.json').write_text('synthetic-auth-fixture')
read=subprocess.run([*sandbox,'cat',str(home/'auth.json')],env=env,capture_output=True,timeout=10)
controls['syntheticAuthReadExitCode']=read.returncode
controls['syntheticAuthVisible']=b'synthetic-auth-fixture' in read.stdout
outside='*** Begin Patch\n*** Add File: /home/appuser/outside.txt\n+must-not-write\n*** End Patch\n'
denied=subprocess.run([*sandbox,binary,'--codex-run-as-apply-patch',outside],env=env,capture_output=True,timeout=10)
controls['outsidePatchExitCode']=denied.returncode
controls['outsidePatchFileExists']=Path('/home/appuser/outside.txt').exists()
controls['workspaceFiles']=[str(p.relative_to('/workspace')) for p in Path('/workspace').rglob('*') if p.is_file()]
controls['outsidePatchOutput']=denied.stdout.decode()
inner="""import os,json,subprocess
from pathlib import Path
def identity(path):
 try:
  value=os.stat(path); return {'device':value.st_dev,'inode':value.st_ino}
 except OSError as error: return {'errno':error.errno}
result={'beforeHome':identity('/home/appuser'),'beforeWorkspace':identity('/workspace')}
command=["""+repr(binary)+""",'--codex-run-as-apply-patch',"""+repr(outside)+"""]
child=subprocess.run(command,capture_output=True,timeout=5)
result['patchExitCode']=child.returncode
result['fileVisibleInside']=Path('/home/appuser/outside.txt').exists()
result['afterHome']=identity('/home/appuser')
result['fileIdentity']=identity('/home/appuser/outside.txt')
try: result['mountNamespace']=os.readlink('/proc/self/ns/mnt')
except OSError as error: result['mountNamespaceErrno']=error.errno
try: result['authVisible']=Path('/home/appuser/.codex/auth.json').read_bytes()==b'synthetic-auth-fixture'
except OSError: result['authVisible']=False
print(json.dumps(result))
"""
inspected=subprocess.run([*sandbox,'python3','-I','-c',inner],env=env,capture_output=True,timeout=10)
assert inspected.returncode==0, inspected.stderr.decode()
controls['sameInvocation']=json.loads(inspected.stdout.splitlines()[-1])
value=os.stat('/home/appuser'); controls['parentHome']={'device':value.st_dev,'inode':value.st_ino}
controls['parentMountNamespace']=os.readlink('/proc/self/ns/mnt')
controls['originalSyntheticAuthUnchanged']=home.joinpath('auth.json').read_bytes()==b'synthetic-auth-fixture'
controls['constructorPolicyUsed']=True
print(json.dumps({'workspacePatchVerified':True,'controls':controls,'credentialsUsed':False,'modelInvocations':0}))
'''
    compile(code,'no-auth-patch-probe','exec')
    d('start',identifier)
    completed = subprocess.run([args.docker,'attach','--sig-proxy=false',identifier],input=code.encode(),capture_output=True,timeout=30)
    (receipt/'stdout').write_bytes(completed.stdout)
    (receipt/'stderr').write_bytes(completed.stderr)
    assert completed.returncode == 0
    result = json.loads(completed.stdout)
    report = {'imageId':args.image,'sourceSha':args.expected_sha,'probeSha256':hashlib.sha256(code.encode()).hexdigest(),'result':result}
    (receipt/'result.json').write_text(json.dumps(report))
    print(json.dumps(report))
finally:
    if created:
        info = json.loads(d('inspect',identifier))[0]
        assert info['Config']['Labels']['teetime.owner'] == name
        d('rm','-f',identifier)
        assert identifier not in d('container','ls','--all','--quiet','--no-trunc','--filter','id='+identifier).decode().split()
    print(json.dumps({'receiptDirectory':str(receipt),'cleanupVerified':True}))
