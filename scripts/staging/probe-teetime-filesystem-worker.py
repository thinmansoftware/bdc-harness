"""Credential-free installed exec-server filesystem diagnostic, not admission."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time

if not __debug__:
    raise RuntimeError('assertion-enabled Python required')
assert os.getuid() == 1001
os.chdir('/workspace')
binary = '/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
env = {'HOME':'/home/appuser','CODEX_HOME':'/home/appuser/.codex','PATH':'/usr/local/bin:/usr/bin:/bin'}
assert subprocess.check_output([binary,'--version'],env=env).strip() == b'codex-cli 0.153.3'
home = Path('/home/appuser/.codex')
assert not home.exists()
home.mkdir(mode=0o700)
auth = home/'auth.json'
auth.write_bytes(b'synthetic-auth-fixture')

# Source-constructed context follows the pinned FileSystemSandboxContext wire
# schema. This is not an attestation of the model turn's effective context.
def special(kind, access, subpath=None):
    value = {'kind':kind}
    if subpath is not None:
        value['subpath'] = subpath
    return {'path':{'type':'special','value':value},'access':access}

entries = [special('root','deny'),special('minimal','read'),
           {'path':{'type':'path','path':'file:///app'},'access':'read'},
           special('project_roots','write'),special('project_roots','read','.git'),
           special('project_roots','read','.codex'),special('project_roots','read','.agents'),
           special('slash_tmp','deny'),special('tmpdir','deny')]
context = {'permissions':{'type':'managed','file_system':{'type':'restricted','entries':entries},
                         'network':'restricted'},'cwd':'file:///workspace',
           'workspaceRoots':['file:///workspace'],'userHomeDir':'file:///home/appuser',
           'windowsSandboxLevel':'disabled','useLegacyLandlock':False}
child = subprocess.Popen([binary,'exec-server','--listen','stdio'],cwd='/workspace',env=env,
                         stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                         start_new_session=True)
selector = selectors.DefaultSelector()
selector.register(child.stdout,selectors.EVENT_READ)
buffer = bytearray()
total = 0
identifier = 0

def rpc(method, params):
    global identifier, total
    identifier += 1
    child.stdin.write(json.dumps({'id':identifier,'method':method,'params':params}).encode()+b'\n')
    child.stdin.flush()
    deadline = time.monotonic()+12
    while time.monotonic() < deadline:
        if not selector.select(.1):
            assert child.poll() is None, 'exec-server exited'
            continue
        chunk = os.read(child.stdout.fileno(),4096)
        assert chunk, 'exec-server closed stdout'
        total += len(chunk)
        assert total <= 65536, 'bounded synthetic diagnostic output'
        buffer.extend(chunk)
        while b'\n' in buffer:
            line, _, rest = buffer.partition(b'\n')
            buffer[:] = rest
            if not line.strip():
                continue
            result = json.loads(line)
            if result.get('id') == identifier:
                return result
    raise TimeoutError('synthetic filesystem RPC timeout')


def classify_response(response):
    if 'result' in response and 'error' not in response:
        return 'filesystem_completed'
    error = response.get('error',{})
    message = str(error.get('message','')).lower()
    if any(hint in message for hint in ['fs sandbox helper','failed to prepare fs sandbox','failed to spawn']):
        return 'backend_failure'
    if error.get('code') in [-32600,-32601,-32602,-32700]:
        return 'protocol_rejection'
    return 'filesystem_error'

try:
    initialized = rpc('initialize',{'clientName':'tee-time-no-auth-filesystem-probe'})
    assert 'result' in initialized and 'error' not in initialized
    child.stdin.write(b'{"method":"initialized","params":{}}\n')
    child.stdin.flush()
    results = {}
    for name, method, params in [
        ('workspaceMetadata','fs/getMetadata',{'path':'file:///workspace','followSymlinks':False}),
        ('workspaceCanonicalize','fs/canonicalize',{'path':'file:///workspace'}),
        ('workspaceCreate','fs/createDirectory',{'path':'file:///workspace','recursive':True,'followSymlinks':False}),
        ('workspaceWrite','fs/writeFile',{'path':'file:///workspace/canary.txt',
            'dataBase64':base64.b64encode(b'tee-time-canary-ready\n').decode(),'followSymlinks':False}),
        ('protectedAuthRead','fs/readFile',{'path':'file:///home/appuser/.codex/auth.json','followSymlinks':False}),
        ('protectedHomeWrite','fs/writeFile',{'path':'file:///home/appuser/outside.txt',
            'dataBase64':base64.b64encode(b'synthetic-outside').decode(),'followSymlinks':False}),
    ]:
        response = rpc(method,{**params,'sandbox':context})
        # Raw error is synthetic only: no real login, model data or network exists.
        category = classify_response(response)
        results[name] = {'success':category == 'filesystem_completed','category':category}
        if 'error' in response:
            results[name]['syntheticError'] = response['error']
    canary = Path('/workspace/canary.txt')
    report = {'operations':results,'context':context,'credentialsUsed':False,'modelInvocations':0,
        'artifactExact':canary.is_file() and canary.read_bytes() == b'tee-time-canary-ready\n',
        'outsideFileExists':Path('/home/appuser/outside.txt').exists(),
        'syntheticAuthUnchanged':auth.read_bytes() == b'synthetic-auth-fixture'}
    workspace_ok = all(results[key]['success'] for key in
        ['workspaceMetadata','workspaceCanonicalize','workspaceCreate','workspaceWrite'])
    report['protectedAccessControlVerified'] = (workspace_ok and
        results['protectedAuthRead']['category'] == 'filesystem_error' and
        results['protectedHomeWrite']['category'] in ['filesystem_completed','filesystem_error'])
    report['diagnosticPassed'] = (workspace_ok and report['artifactExact'] and
        report['protectedAccessControlVerified'] and not report['outsideFileExists'] and report['syntheticAuthUnchanged'])
    print(json.dumps(report),flush=True)
finally:
    selector.close()
    if child.poll() is None:
        os.killpg(child.pid,signal.SIGKILL)
    child.wait(timeout=3)
