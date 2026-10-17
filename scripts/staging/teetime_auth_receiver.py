"""Unregistered stdin-to-tmpfs receiver candidate. Never invoke on a host."""
import base64
import json
import math
import os
from pathlib import Path
import signal
import sys
import time

REJECTED='credential receipt rejected'

def reject_constant(value): raise ValueError(REJECTED)

def unique_object(pairs):
    result={}
    for key,value in pairs:
        if key in result: raise ValueError(REJECTED)
        result[key]=value
    return result

def validate_payload(stream,now):
    try:
        raw=stream.read(65537)
        if not raw or len(raw)>65536: raise ValueError(REJECTED)
        data=json.loads(raw,object_pairs_hook=unique_object,parse_constant=reject_constant)
        if data.get('auth_mode')!='chatgpt': raise ValueError(REJECTED)
        if set(data)-{'auth_mode','tokens','last_refresh','OPENAI_API_KEY'} or data.get('OPENAI_API_KEY'):
            raise ValueError(REJECTED)
        tokens=data['tokens']
        if set(tokens)!={'access_token','id_token','refresh_token','account_id'}: raise ValueError(REJECTED)
        for field in ['access_token','id_token','refresh_token','account_id']:
            if not isinstance(tokens.get(field),str) or not tokens[field]: raise ValueError(REJECTED)
        parts=tokens['access_token'].split('.')
        if len(parts)!=3: raise ValueError(REJECTED)
        claims=json.loads(base64.urlsafe_b64decode(parts[1]+'='*((-len(parts[1]))%4)),object_pairs_hook=unique_object,parse_constant=reject_constant)
        expires=claims['exp']
        if isinstance(expires,bool) or not isinstance(expires,(int,float)) or not math.isfinite(expires) or not expires>now+1800:
            raise ValueError(REJECTED)
        return raw
    except Exception:
        raise ValueError(REJECTED) from None

def receive():
    # The launcher must independently inspect the container, mounts, networks,
    # image and process before providing stdin. These checks are defense in depth.
    if sys.platform!='linux' or os.getuid()!=1001: raise ValueError(REJECTED)
    mount_records=Path('/proc/self/mountinfo').read_text().splitlines()
    matches=[line.split(' - ',1) for line in mount_records if line.split()[4]=='/home/appuser']
    if len(matches)!=1 or matches[0][1].split()[0]!='tmpfs': raise ValueError(REJECTED)
    parent=Path('/home/appuser')
    if parent.is_symlink() or parent.stat().st_uid!=1001: raise ValueError(REJECTED)
    home=parent/'.codex'
    home.mkdir(mode=0o700,exist_ok=False)
    path=home/'auth.json'
    created=False
    try:
        if home.stat().st_uid!=1001 or home.stat().st_mode & 0o777 != 0o700:
            raise ValueError(REJECTED)
        raw=validate_payload(sys.stdin.buffer,time.time())
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        created=True
        with os.fdopen(fd,'wb') as output:
            output.write(raw)
        if path.stat().st_uid!=1001 or path.stat().st_mode & 0o777 != 0o600: raise ValueError(REJECTED)
        print('{"installed":true}',flush=True)
    except BaseException:
        if created: path.unlink(missing_ok=True)
        home.rmdir()
        raise

if __name__=='__main__':
    try:
        # Bounded blocking stdin; no payload or traceback is emitted on failure.
        if sys.platform=='linux':
            def timed_out(signum,frame): raise TimeoutError(REJECTED)
            signal.signal(signal.SIGALRM,timed_out)
            signal.alarm(10)
        receive()
    except BaseException:
        print('{"installed":false}',flush=True)
        sys.exit(1)
    finally:
        if sys.platform=='linux': signal.alarm(0)
