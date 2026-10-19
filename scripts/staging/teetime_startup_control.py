"""Private diagnostic context and fixed identity checks; never grant admission."""
import os
from pathlib import Path
import re
import stat
import subprocess
import json
import math
import time
from teetime_bounded_process import capture

CATALOG_HASH='e5a56e880294de40cfd546abc67943839247ef41f9fea095c6ffc93ca4f53e14'
BINARY_HASH='f9d4eab23d0e0726340e084ed22d668885c1dcabeb29ec508b8962e5e29b8dc6'


def startup_settings(owner):
    if re.fullmatch('teetime-startup-[0-9]+-[0-9]+',owner or '') is None:
        raise ValueError('startup owner rejected')
    return ['--label','teetime.startup-fixture='+owner,
            '--env','TEE_TIME_STARTUP_BINARY_HASH='+BINARY_HASH,
            '--pids-limit','128','--memory','768m','--memory-swap','768m','--cpus','1']


def verify_startup_identity(metadata):
    if metadata['binaryHash']!=BINARY_HASH or metadata['catalogHash']!=CATALOG_HASH:
        raise ValueError('startup binary or catalog identity mismatch')


def require_private_repository():
    # Host-only gh credential use. Nothing from this environment enters the CLI.
    result=subprocess.run(['gh','api','repos/thinmansoftware/bdc-xo','--jq','.private'],
                          capture_output=True,text=True,timeout=20)
    if result.returncode or result.stdout.strip()!='true':
        raise RuntimeError('startup private repository check failed')


def require_private_context(root,owner,environment=None):
    environment=os.environ if environment is None else environment
    if (environment.get('GITHUB_ACTIONS')!='true'
            or environment.get('GITHUB_REPOSITORY')!='thinmansoftware/bdc-xo'
            or environment.get('GITHUB_EVENT_NAME')!='workflow_dispatch'):
        raise ValueError('startup private dispatch context rejected')
    run=environment.get('GITHUB_RUN_ID','')
    attempt=environment.get('GITHUB_RUN_ATTEMPT','')
    if not run.isascii() or not run.isdigit() or not attempt.isascii() or not attempt.isdigit():
        raise ValueError('startup job identity rejected')
    if owner!='teetime-startup-'+run+'-'+attempt:
        raise ValueError('startup owner context mismatch')
    if os.name!='posix': raise RuntimeError('startup host requires POSIX')
    temporary=Path(environment.get('RUNNER_TEMP',''))
    root=Path(root)
    if (not temporary.is_absolute() or not root.is_absolute() or root.is_symlink()
            or root.absolute()!=root.resolve(strict=True)
            or root!=temporary.resolve(strict=True)/('teetime-private-'+run+'-'+attempt)):
        raise ValueError('startup trusted root context rejected')
    info=root.stat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o700 or info.st_uid!=os.getuid():
        raise ValueError('startup trusted root ownership rejected')
    require_private_repository()


_RESOURCE_FIELDS=('memoryAvailableBytes','diskFreeBytes','visibleControllerCgroupOomKills')

def resource_snapshot():
    """Fixed bounded counters visible to the controller; never OOM attribution."""
    value={key:None for key in _RESOURCE_FIELDS}
    def text(path,limit):
        with open(path,'rb') as source:
            raw=source.read(limit+1)
        if len(raw)>limit:raise ValueError('resource counter bound')
        return raw.decode('ascii')
    try:
        rows=[line.split() for line in text('/proc/meminfo',65536).splitlines()]
        matches=[row for row in rows if len(row)==3 and row[0]=='MemAvailable:' and row[2]=='kB']
        if len(matches)==1 and matches[0][1].isdigit():
            value['memoryAvailableBytes']=int(matches[0][1])*1024
    except (OSError,ValueError,UnicodeError):pass
    try:
        disk=os.statvfs('/')
        value['diskFreeBytes']=disk.f_bavail*disk.f_frsize
    except (OSError,AttributeError):pass
    try:
        rows=[line.split() for line in text('/sys/fs/cgroup/memory.events',4096).splitlines()]
        matches=[row for row in rows if len(row)==2 and row[0]=='oom_kill']
        if len(matches)==1 and matches[0][1].isdigit():
            value['visibleControllerCgroupOomKills']=int(matches[0][1])
    except (OSError,ValueError,UnicodeError):pass
    return {key:item if type(item) is int and 0<=item<=9007199254740991 else None
            for key,item in value.items()}


class StartupController:
    """Startup-only host deadline and closed, flushed observation boundary."""
    PHASES={'controller','image-inspect','container-create','container-inspect',
            'container-start','attach','container-inventory','container-remove',
            'cleanup','resources-before','resources-after'}

    def __init__(self,owner,name,*,clock=time.monotonic,emitter=None,runner=capture):
        startup_settings(owner)
        if re.fullmatch('teetime-startup-[0-9]{1,20}-[0-9]{1,10}',owner) is None:
            raise ValueError('startup controller owner bound')
        if re.fullmatch('teetime-sandbox-probe-[a-f0-9]{12}',name or '') is None:
            raise ValueError('startup controller resource rejected')
        self.owner=owner;self.name=name;self.clock=clock;self.runner=runner
        self.started=clock();self.main_deadline=self.started+120
        self.absolute_deadline=self.started+150;self.cleanup_deadline=None
        self.events=0;self.logging_failed=False
        self.emitter=emitter or (lambda value:print(json.dumps(value,separators=(',',':')),flush=True))

    def emit(self,phase,edge,exit_code=None,resources=None):
        if (phase not in self.PHASES or edge not in {'start','end','failure'}
                or not (exit_code is None or type(exit_code) is int and -255<=exit_code<=255)):
            raise ValueError('startup milestone fields rejected')
        if self.events>=64 or self.logging_failed:return False
        elapsed=self.clock()-self.started
        if not math.isfinite(elapsed) or elapsed<0:return False
        value={'kind':'teetime-startup-controller-milestone-v1','phase':phase,'edge':edge,
               'elapsedMs':min(2147483647,int(elapsed*1000)),
               'owner':self.owner,'containerName':self.name,'exitCode':exit_code}
        if resources is not None:
            if (phase not in {'resources-before','resources-after'}
                    or type(resources) is not dict or set(resources)!=set(_RESOURCE_FIELDS)
                    or any(v is not None and (type(v) is not int or not 0<=v<=9007199254740991)
                           for v in resources.values())):
                raise ValueError('startup resource projection rejected')
            value['resourceScope']='controller-visible-filesystem'
            value['resources']=dict(resources)
        if len(json.dumps(value,separators=(',',':')).encode('ascii'))>1024:
            self.logging_failed=True;return False
        self.events+=1
        try:self.emitter(value)
        except Exception:
            self.logging_failed=True;return False
        return True

    def remaining(self,maximum):
        deadline=self.main_deadline if self.cleanup_deadline is None else self.cleanup_deadline
        remaining=deadline-self.clock()-5
        if not math.isfinite(remaining) or remaining<=0:
            raise TimeoutError('startup controller deadline exhausted')
        return min(maximum,remaining)

    def enter_cleanup(self):
        if self.cleanup_deadline is None:
            self.cleanup_deadline=min(self.absolute_deadline,self.clock()+30)
        self.emit('cleanup','start')

    def finish_cleanup(self,success):
        if type(success) is not bool:raise ValueError('startup cleanup outcome rejected')
        self.emit('cleanup','end' if success else 'failure')

    def resources(self,when):
        if when not in {'before','after'}:raise ValueError('startup resource phase rejected')
        value={key:None for key in _RESOURCE_FIELDS}
        try:
            snapshot=resource_snapshot()
            if type(snapshot) is dict and set(snapshot)==set(_RESOURCE_FIELDS):
                value={key:item if type(item) is int and 0<=item<=9007199254740991 else None
                       for key,item in snapshot.items()}
        except Exception:pass
        self.emit('resources-'+when,'end',resources=value)

    def command(self,argv,phase,maximum,limit,input_bytes=None):
        if phase not in self.PHASES:raise ValueError('startup command phase rejected')
        emitted=self.emit(phase,'start')
        if not emitted and self.cleanup_deadline is None:
            raise RuntimeError('startup controller observation unavailable')
        try:
            timeout=self.remaining(maximum)
        except TimeoutError:
            self.emit(phase,'failure');raise
        try:
            result=self.runner(argv,timeout=timeout,limit=limit,input_bytes=input_bytes)
            code,output=result
            if type(code) is not int or not -255<=code<=255 or type(output) is not bytes:
                raise ValueError('startup command result rejected')
        except Exception:
            self.emit(phase,'failure')
            raise RuntimeError('startup host command outcome unconfirmed') from None
        self.emit(phase,'end',code)
        return result

    def docker(self,executable,*parts,check=False):
        if parts[:2]==('image','inspect'):phase='image-inspect'
        elif parts[:2]==('container','ls'):phase='container-inventory'
        else:
            phase={'create':'container-create','inspect':'container-inspect',
                   'start':'container-start','rm':'container-remove'}.get(parts[0] if parts else '')
        if phase is None:raise ValueError('startup Docker operation rejected')
        code,output=self.command([executable,*parts],phase,120,131072)
        try:decoded=output.decode('utf-8')
        except UnicodeError:raise RuntimeError('startup host command encoding rejected') from None
        if check and code!=0:raise RuntimeError('startup host command rejected')
        return subprocess.CompletedProcess([],code,decoded,'')

    def attach(self,argv,source):
        return self.command(argv,'attach',90,65536,input_bytes=source)
