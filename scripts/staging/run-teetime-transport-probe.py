"""Credential-free transport probe; source-only candidate, no lane admission."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

if not __debug__:
    raise SystemExit('Assertions required')
parser=argparse.ArgumentParser()
parser.add_argument('--docker',default='docker')
parser.add_argument('--image',required=True)
parser.add_argument('--expected-sha',required=True)
parser.add_argument('--sandbox',action='store_true')
args=parser.parse_args()
profile=Path(__file__).with_name('codex-probe-seccomp.json')
if args.sandbox:
    baseline=json.loads(profile.with_name('moby-default-seccomp.json').read_text())
    inventory=json.loads(profile.with_name('codex-probe-minimization.json').read_text())
    candidate=json.loads(profile.read_text())
    assert len(inventory)==12 and all(item['removed'] is False for item in inventory)
    assert candidate=={**baseline,'syscalls':baseline['syscalls']+[item['rule'] for item in inventory]}
name='teetime-transport-'+uuid.uuid4().hex[:12]
internal=name+'-internal';egress=name+'-egress';gateway=name+'-gateway';worker=name+'-worker'
source=Path(__file__).with_name('teetime_connect_proxy.py').read_bytes()
owned=[];networks=[];process=None
receipt=Path.cwd()/name
receipt.mkdir(exist_ok=False)
network_receipts=[]

def d(*parts,**kwargs):
    return subprocess.run([args.docker,*parts],capture_output=True,check=True,timeout=40,**kwargs).stdout

def inspect(target): return json.loads(d('inspect',target))[0]

def check(target, expected_networks):
    s=inspect(target);h=s['HostConfig'];c=s['Config']
    assert s['Image']==image and c['User']=='1001:1001'
    assert h['ReadonlyRootfs'] and not h['Privileged'] and h['CapDrop']==['ALL'] and not h.get('CapAdd')
    if target==worker and args.sandbox:
        assert 'no-new-privileges:true' in h['SecurityOpt'] and len(h['SecurityOpt'])==2
        seccomp=[v for v in h['SecurityOpt'] if v.startswith('seccomp=')]
        assert len(seccomp)==1 and json.loads(seccomp[0][8:])==candidate
        assert set(h['Tmpfs'])=={'/home/appuser','/workspace','/tmp','/workspace/.codex','/workspace/.agents'}
        for path in ['/workspace/.codex','/workspace/.agents']:
            assert 'ro' in h['Tmpfs'][path].split(',')
    else:
        assert h['SecurityOpt']==['no-new-privileges:true'] and not h.get('Tmpfs')
    assert not s['Mounts'] and not any(h.get(k) for k in ['Binds','Devices','DeviceRequests','PortBindings','PidMode'])
    assert set(s['NetworkSettings']['Networks'])==set(expected_networks)
    assert h['Memory']==256*1024**2 and h['MemorySwap']==h['Memory'] and h['NanoCpus']==1000000000 and h['PidsLimit']==64
    assert c['Labels']['teetime.owner']==name
    assert c['Entrypoint']==['python3'] and c['Cmd']==['-I','-']
    return s

try:
    image_state=json.loads(d('image','inspect',args.image))[0];image=image_state['Id']
    assert 'ARCHON_BUILD_SHA='+args.expected_sha in image_state['Config']['Env']
    for network,is_internal in [(internal,True),(egress,False)]:
        d('network','create','--driver','bridge','--label','teetime.owner='+name,*(['--internal'] if is_internal else []),network)
        networks.append(network)
        n=json.loads(d('network','inspect',network))[0]
        assert n['Internal']==is_internal and n['Labels']['teetime.owner']==name
        network_receipts.append({'name':network,'id':n['Id'],'internal':n['Internal']})
    (receipt/'networks.json').write_text(json.dumps(network_receipts,indent=2))
    for target,network in [(gateway,egress),(worker,internal)]:
        extra=[]
        if target==worker and args.sandbox:
            extra=['--security-opt','seccomp='+str(profile)]
            for path in ['/home/appuser','/workspace','/tmp']:
                extra+=['--tmpfs',path+':uid=1001,gid=1001,size=64m']
            for path in ['/workspace/.codex','/workspace/.agents']:
                extra+=['--tmpfs',path+':ro,uid=1001,gid=1001,size=1m']
        d('create','-i','--name',target,'--label','teetime.owner='+name,'--network',network,
          '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1001:1001',
          '--memory','256m','--memory-swap','256m','--cpus','1','--pids-limit','64','--no-healthcheck',
          *extra,'--entrypoint','python3',image,'-I','-')
        owned.append(target)
    d('network','connect','--alias','teetime-proxy',internal,gateway)
    check(gateway,[internal,egress]);check(worker,[internal])
    d('start',gateway)
    assert check(gateway,[internal,egress])['State']['Running']
    process=subprocess.Popen([args.docker,'attach','--sig-proxy=false',gateway],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    process.stdin.write(source);process.stdin.close();process.stdin=None
    code=r'''
import socket,ssl,time,json
def request(host):
 s=socket.create_connection(('teetime-proxy',3128),timeout=5)
 s.sendall(('CONNECT '+host+':443 HTTP/1.1\r\nHost: '+host+':443\r\n\r\n').encode())
 b=b''
 while not b.endswith(b'\r\n\r\n'):
  v=s.recv(1)
  if not v: raise RuntimeError('early proxy close')
  b+=v
 return s,b
for attempt in range(30):
 try:
  s=socket.create_connection(('teetime-proxy',3128),timeout=1);s.close();break
 except OSError:
  if attempt==29: raise
  time.sleep(.1)
for host in ['auth.openai.com','example.com','127.0.0.1','169.254.169.254']:
 s,b=request(host);assert b.startswith(b'HTTP/1.1 403');s.close()
s,b=request('chatgpt.com');assert b.startswith(b'HTTP/1.1 200')
with ssl.create_default_context().wrap_socket(s,server_hostname='chatgpt.com') as tls:
 tls.sendall(b'HEAD / HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n')
 reply=tls.recv(512);assert reply.startswith(b'HTTP/')
try:
 s=socket.create_connection(('1.1.1.1',443),timeout=2)
except OSError: pass
else: s.close();raise RuntimeError('worker direct egress unexpectedly reachable')
result={'proxyTlsVerified':True,'forbiddenDestinationsRejected':4,'workerDirectPublicDenied':True,'credentialsUsed':False}
'''
    if args.sandbox:
        code+='\n'+Path(__file__).with_name('probe-teetime-proxy-sandbox.py').read_text()
    code+='\nprint(json.dumps(result))\n'
    compile(code,'credential-free-probe','exec')
    d('start',worker);assert check(worker,[internal])['State']['Running']
    completed=subprocess.run([args.docker,'attach','--sig-proxy=false',worker],input=code.encode(),capture_output=True,timeout=40)
    (receipt/'worker.stdout').write_bytes(completed.stdout)
    (receipt/'worker.stderr').write_bytes(completed.stderr)
    if completed.returncode:
        raise RuntimeError('Credential-free worker failed; inspect worker.stderr receipt')
    output=completed.stdout
    assert inspect(worker)['State']['ExitCode']==0
    result=json.loads(output)
    result={'result':result,'imageId':image,'sourceSha':args.expected_sha,
        'proxySourceSha256':hashlib.sha256(source).hexdigest(),'internalNetwork':internal,
        'networks':network_receipts,'workerProbeSha256':hashlib.sha256(code.encode()).hexdigest(),
        'note':'Credential-free probe only; CLI application transport and authenticated checks remain separate'}
    (receipt/'result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
finally:
    errors=[]
    if gateway in owned:
        try:
            s=inspect(gateway)
            assert s['Config']['Labels']['teetime.owner']==name
            if s['State']['Running']:
                d('kill','--signal','SIGINT',gateway)
                d('wait',gateway)
            logs=subprocess.run([args.docker,'logs',gateway],capture_output=True,timeout=10)
            (receipt/'gateway.stdout').write_bytes(logs.stdout)
            (receipt/'gateway.stderr').write_bytes(logs.stderr)
            (receipt/'gateway-state.json').write_text(json.dumps(inspect(gateway)['State'],indent=2))
        except Exception as error:
            errors.append({'resource':gateway,'phase':'receipt','errorType':type(error).__name__})
    for target in reversed(owned):
        try:
            s=inspect(target)
            assert s['Config']['Labels']['teetime.owner']==name
            d('rm','-f',target)
        except Exception as error:
            errors.append({'resource':target,'phase':'remove','errorType':type(error).__name__})
    if process:
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill();process.communicate(timeout=5)
            errors.append({'resource':gateway,'phase':'attach-reap','errorType':'Timeout'})
    for network in reversed(networks):
        try:
            n=json.loads(d('network','inspect',network))[0]
            assert n['Labels']['teetime.owner']==name and not n.get('Containers')
            d('network','rm',network)
        except Exception as error:
            errors.append({'resource':network,'phase':'remove','errorType':type(error).__name__})
    (receipt/'cleanup.json').write_text(json.dumps({'errors':errors},indent=2))
    print(json.dumps({'receiptDirectory':str(receipt),'cleanupErrors':errors}))
    if errors: raise RuntimeError('Cleanup or receipt failure; inspect owned resource list')
