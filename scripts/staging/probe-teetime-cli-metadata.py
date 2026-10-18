# Credential-free negative metadata probe, appended only inside inspected worker.
import base64
import os
import selectors
import signal
from datetime import datetime, timezone

def synthetic_jwt(payload):
    def enc(value): return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
    return enc({'alg':'RS256','typ':'JWT'})+'.'+enc(payload)+'.c3ludGhldGljLWludmFsaWQ'

assert not (home/'auth.json').exists()
claims={'exp':int(time.time())+3600,'email':'synthetic@example.invalid',
        'https://api.openai.com/auth':{'chatgpt_account_id':'synthetic-invalid-account','chatgpt_plan_type':'plus'}}
fake=synthetic_jwt(claims)
auth={'auth_mode':'chatgpt','tokens':{'id_token':fake,'access_token':fake,
      'refresh_token':'synthetic-invalid-refresh','account_id':'synthetic-invalid-account'},
      'last_refresh':datetime.now(timezone.utc).isoformat()}
auth_path=home/'auth.json'
auth_path.write_text(json.dumps(auth));auth_path.chmod(0o600)
# Reuse the pinned image's policy. Only the fixed proxy env is added for this
# application transport probe; the separate TS source profile is tested in CI.
policy=json.loads(subprocess.check_output(['bun','-e',
    'import {restrictedClientOptions} from "/app/packages/providers/src/codex/restricted-policy.ts"; console.log(JSON.stringify(restrictedClientOptions()))'],env=env,text=True))
child_env=policy['env']|{'HTTPS_PROXY':'http://teetime-proxy:3128','HTTP_PROXY':'http://teetime-proxy:3128'}
argv=[binary,'app-server','--stdio','--strict-config']
def flatten(value,prefix=''):
    for key,item in value.items():
        path=prefix+'.'+key if prefix else key
        if isinstance(item,dict): flatten(item,path)
        else: argv.extend(['-c',path+'='+json.dumps(item,separators=(',',':'))])
flatten(policy['config'])
for override in policy['configOverrides']: argv.extend(['-c',override])
child=subprocess.Popen(argv,env=child_env,cwd='/workspace',stdin=subprocess.PIPE,
                       stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
buffer=b'';deadline=time.monotonic()+20;verified=False
def send(message):
    child.stdin.write(json.dumps(message).encode()+b'\n');child.stdin.flush()
try:
    send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'teetime_metadata_probe','version':'1'},'capabilities':{'experimentalApi':True}}})
    while time.monotonic()<deadline and not verified:
        if not selector.select(.2):
            assert child.poll() is None, 'metadata CLI exited early'
            continue
        chunk=os.read(child.stdout.fileno(),65536)
        assert chunk, 'metadata CLI closed output'
        buffer+=chunk
        assert len(buffer)<262144, 'metadata output bound'
        while b'\n' in buffer:
            line,buffer=buffer.split(b'\n',1)
            if not line.strip(): continue
            message=json.loads(line)
            if message.get('id')==1:
                assert 'result' in message and 'error' not in message, 'initialization failed'
                send({'method':'initialized'})
                send({'id':2,'method':'account/rateLimits/read'})
            elif message.get('id')==2:
                assert 'error' in message and 'result' not in message, 'unexpected metadata success'
                error=str(message['error'].get('message','')).lower()
                assert '401' in error or 'unauthorized' in error, 'metadata did not return verified auth rejection'
                verified=True
    assert verified, 'metadata timeout'
    result['cliMetadataUnauthorized']=True
    result['inferenceRequested']=False
finally:
    selector.close()
    if child.poll() is None: os.killpg(child.pid,signal.SIGKILL)
    child.wait(timeout=3)
    auth_path.unlink(missing_ok=True)
