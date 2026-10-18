"""Synthetic-only receiver subprocess checks in a fresh no-network container."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import time
import uuid

if not __debug__: raise SystemExit('Assertions required')

parser=argparse.ArgumentParser()
parser.add_argument('--docker',default='docker')
parser.add_argument('--image',required=True)
args=parser.parse_args()
source=Path(__file__).with_name('teetime_auth_receiver.py').read_text()
name='teetime-receiver-test-'+uuid.uuid4().hex[:12]
results=[]
def d(*parts,**kwargs):
    return subprocess.run([args.docker,*parts],capture_output=True,check=True,timeout=30,**kwargs).stdout
def state(): return json.loads(d('inspect',name))[0]
def probe(code): return d('exec',name,'python3','-I','-c',code)
def fixture(exp):
    claims=base64.urlsafe_b64encode(json.dumps({'exp':exp}).encode()).rstrip(b'=').decode()
    return json.dumps({'auth_mode':'chatgpt','tokens':{'access_token':'synthetic.'+claims+'.invalid',
        'id_token':'synthetic','refresh_token':'synthetic','account_id':'synthetic'}}).encode()
image=json.loads(d('image','inspect',args.image))[0]['Id']
try:
    d('create','--name',name,'--label','teetime.owner='+name,'--network','none','--read-only',
      '--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1001:1001',
      '--tmpfs','/home/appuser:uid=1001,gid=1001,size=1m','--memory','128m','--memory-swap','128m',
      '--cpus','1','--pids-limit','32','--no-healthcheck','--entrypoint','python3',image,
      '-I','-c','import time; time.sleep(180)')
    s=state();h=s['HostConfig'];c=s['Config']
    assert s['Image']==image and c['User']=='1001:1001' and h['NetworkMode']=='none'
    assert h['ReadonlyRootfs'] and not h['Privileged'] and h['CapDrop']==['ALL'] and not h.get('CapAdd')
    assert h['SecurityOpt']==['no-new-privileges:true'] and not s['Mounts']
    assert set(h['Tmpfs'])=={'/home/appuser'} and not any(h.get(k) for k in ['Binds','Devices','DeviceRequests','PortBindings','PidMode'])
    assert c['Entrypoint']==['python3'] and c['Cmd']==['-I','-c','import time; time.sleep(180)']
    d('start',name)
    for kind in ['valid','malformed','oversized','expired','existing','symlink','alarm']:
        if kind=='existing': probe('from pathlib import Path; Path("/home/appuser/.codex").mkdir(mode=0o700)')
        if kind=='symlink': probe('from pathlib import Path; Path("/home/appuser/.codex").symlink_to("/tmp")')
        payload=fixture(time.time()+3600)
        if kind=='malformed': payload=b'not json'
        if kind=='oversized': payload=b'x'*65537
        if kind=='expired': payload=fixture(time.time()-1)
        command=[args.docker,'exec','-i',name,'python3','-I','-c',source]
        if kind=='alarm':
            child=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                child.wait(timeout=15)
                child.stdin.close();child.stdin=None
                output,error=child.communicate(timeout=3)
                code=child.returncode
            finally:
                if child.poll() is None: child.kill();child.communicate(timeout=3)
        else:
            child=subprocess.run(command,input=payload,capture_output=True,timeout=15)
            output,error,code=child.stdout,child.stderr,child.returncode
        assert not error, 'receiver emitted stderr'
        assert json.loads(output)=={'installed':kind=='valid'} and code==(0 if kind=='valid' else 1)
        if kind=='valid':
            details=json.loads(probe('import json,os; from pathlib import Path; p=Path("/home/appuser/.codex"); print(json.dumps([[x.stat().st_uid,x.stat().st_mode&511] for x in [p,p/"auth.json"]]))'))
            assert details==[[1001,448],[1001,384]]
            probe('from pathlib import Path; p=Path("/home/appuser/.codex"); (p/"auth.json").unlink(); p.rmdir()')
        elif kind=='existing':
            probe('from pathlib import Path; p=Path("/home/appuser/.codex"); assert not list(p.iterdir()); p.rmdir()')
        elif kind=='symlink':
            probe('from pathlib import Path; p=Path("/home/appuser/.codex"); assert p.is_symlink(); p.unlink()')
        else:
            probe('from pathlib import Path; assert not Path("/home/appuser/.codex").exists()')
        results.append(kind)
finally:
    s=state();assert s['Config']['Labels']['teetime.owner']==name
    d('rm','-f',name)
print(json.dumps({'imageId':image,'syntheticOnly':True,'passed':results,'containerRemoved':True}))
