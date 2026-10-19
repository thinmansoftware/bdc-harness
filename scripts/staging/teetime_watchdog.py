"""Independent deadline cleanup for explicitly owned canary Docker resources."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time

def validate_manifest(data,now,task='canary'):
    if task not in ['canary','supervised-demo']: raise ValueError('closed watchdog task required')
    if not isinstance(data,dict) or set(data)!={'owner','deadline','containers','networks'}:
        raise ValueError('invalid watchdog manifest')
    if not re.fullmatch(r'teetime-auth-[a-f0-9]{12}',str(data['owner'])):
        raise ValueError('invalid owner')
    deadline=data['deadline']
    maximum=780 if task=='supervised-demo' else 300
    if isinstance(deadline,bool) or not isinstance(deadline,(int,float)) or not math.isfinite(deadline) or not now<deadline<=now+maximum:
        raise ValueError('invalid deadline')
    ids=[]
    for key in ['containers','networks']:
        values=data[key]
        if not isinstance(values,list) or not 1<=len(values)<=2:
            raise ValueError('invalid resource count')
        if any(not isinstance(v,str) or not re.fullmatch('[a-f0-9]{64}',v) for v in values):
            raise ValueError('invalid resource id')
        ids+=values
    if len(set(ids))!=len(ids): raise ValueError('duplicate resource id')
    return data

def cleanup(docker,manifest):
    errors=[]
    def command(*args):
        return subprocess.run([docker,*args],capture_output=True,timeout=12,check=True).stdout
    for kind,key in [('container','containers'),('network','networks')]:
        for resource in manifest[key]:
            try:
                # A successful list distinguishes absent resources from daemon failure.
                listing=command(kind,'ls','--quiet','--no-trunc',*(['--all'] if kind=='container' else []),'--filter','id='+resource).decode().split()
                if resource not in listing: continue
                info=json.loads(command(kind,'inspect',resource))[0]
                labels=info['Config']['Labels'] if kind=='container' else info['Labels']
                if info['Id']!=resource or labels.get('teetime.owner')!=manifest['owner']:
                    raise ValueError('ownership mismatch')
                command(kind,'rm',*(['--force'] if kind=='container' else []),resource)
                remaining=command(kind,'ls','--quiet','--no-trunc',*(['--all'] if kind=='container' else []),'--filter','id='+resource).decode().split()
                if resource in remaining: raise ValueError('removal not verified')
            except Exception as error:
                errors.append({'kind':kind,'id':resource,'failure':type(error).__name__})
    return errors

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--docker',required=True)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--task',choices=['canary','supervised-demo'],default='canary')
    args=parser.parse_args()
    if args.manifest.stat().st_size>4096: raise ValueError('oversized manifest')
    raw=args.manifest.read_bytes()
    manifest=validate_manifest(json.loads(raw),time.time(),args.task)
    root=args.manifest.parent
    # Convert once to monotonic time so a wall-clock adjustment cannot extend it.
    deadline=time.monotonic()+max(0,manifest['deadline']-time.time())
    ready={'owner':manifest['owner'],'pid':os.getpid(),'deadline':manifest['deadline'],
           'manifestSha256':hashlib.sha256(raw).hexdigest()}
    with (root/'watchdog-ready.tmp').open('x') as output: json.dump(ready,output)
    (root/'watchdog-ready.tmp').replace(root/'watchdog-ready.json')
    while time.monotonic()<deadline: time.sleep(max(0,min(.2,deadline-time.monotonic())))
    errors=cleanup(args.docker,manifest)
    with (root/'watchdog-result.json').open('x') as output:
        json.dump({'owner':manifest['owner'],'cleanupVerified':not errors,'errors':errors},output)
    return 1 if errors else 0

if __name__=='__main__':
    try: raise SystemExit(main())
    except Exception: raise SystemExit('watchdog failed; inspect owned resources') from None
