"""No-auth failure injection: a detached watchdog must outlive this launcher."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from teetime_watchdog import cleanup

parser=argparse.ArgumentParser()
parser.add_argument('--docker',required=True)
parser.add_argument('--image',required=True)
parser.add_argument('--disconnect',action='store_true')
args=parser.parse_args()
if os.name!='nt' or not __debug__: raise SystemExit('Windows assertion-enabled probe required')
name='teetime-auth-'+uuid.uuid4().hex[:12]
root=Path.home()/name;root.mkdir()
manifest={'owner':name,'deadline':time.time()+25,'containers':[],'networks':[]}
def d(*parts): return subprocess.check_output([args.docker,*parts],timeout=15).decode().strip()
try:
    image=json.loads(d('image','inspect',args.image))[0]['Id']
    network=d('network','create','--internal','--label','teetime.owner='+name,name)
    manifest['networks'].append(network)
    worker=d('create','--name',name,'--label','teetime.owner='+name,'--network',network,
        '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1001:1001',
        '--tmpfs','/home/appuser:uid=1001,gid=1001,size=1m','--memory','128m','--memory-swap','128m',
        '--cpus','1','--pids-limit','16','--no-healthcheck','--entrypoint','python3',image,
        '-I','-c','import time; time.sleep(180)')
    manifest['containers'].append(worker)
    state=json.loads(d('inspect',worker))[0];host=state['HostConfig']
    assert state['Image']==image and host['NetworkMode']==network and not state['Mounts']
    assert host['ReadonlyRootfs'] and not host['Privileged'] and host['CapDrop']==['ALL']
    assert state['Config']['User']=='1001:1001' and not host.get('Binds') and not host.get('PortBindings')
    d('start',worker)
    (root/'manifest.json').write_text(json.dumps(manifest))
    subprocess.Popen([sys.executable,str(Path(__file__).with_name('teetime_watchdog.py')),
        '--docker',args.docker,'--manifest',str(root/'manifest.json')],
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.CREATE_BREAKAWAY_FROM_JOB,close_fds=True)
    for attempt in range(50):
        if (root/'watchdog-ready.json').exists(): break
        time.sleep(.1)
    ready=json.loads((root/'watchdog-ready.json').read_text())
    assert ready['owner']==name and ready['deadline']==manifest['deadline']
    assert ready['manifestSha256']==hashlib.sha256((root/'manifest.json').read_bytes()).hexdigest()
    assert manifest['deadline']-time.time()>10
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.restype=ctypes.c_void_p
    kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
    kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=kernel.OpenProcess(0x1000,False,ready['pid'])
    assert handle
    exit_code=ctypes.c_ulong()
    try: assert kernel.GetExitCodeProcess(handle,ctypes.byref(exit_code)) and exit_code.value==259
    finally: kernel.CloseHandle(handle)
    print(json.dumps({'receiptDirectory':str(root),'workerId':worker,'watchdogReady':True}),flush=True)
except BaseException:
    errors=cleanup(args.docker,manifest)
    (root/'early-failure-cleanup.json').write_text(json.dumps({'errors':errors}))
    raise
if args.disconnect: time.sleep(180)
os._exit(23)  # Deliberately bypass finally and simulate a launcher crash.
