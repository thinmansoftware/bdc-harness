"""Read-only committed base. Trusted controller owns repo/executable/helper custody."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parent))
from teetime_bounded_process import capture
from teetime_git_objects import build_git_objects
from teetime_materialization_frame import encode_frame
from teetime_snapshot import MAX_FILE, MAX_FILES, MAX_TOTAL, SnapshotFile, snapshot_manifest, valid_path

MAX_OUTPUT=65536
MAX_COMMIT=65536
MAX_METADATA_ENTRIES=8192
REMOTE='thinmansoftware/whats-that-tee-time'


def encode_result(value):
    raw=json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
    if len(raw)+1>MAX_OUTPUT:raise ValueError('complete base exceeds controller output bound')
    return raw


def safe_metadata(root):
    gitdir=root/'.git'
    def indirect(path):
        if not os.path.lexists(path):return False
        return path.is_symlink() or bool(getattr(path.lstat(),'st_file_attributes',0)&0x400)
    if not gitdir.is_dir() or indirect(gitdir):raise ValueError('canonical checkout metadata required')
    for name in ['refs','refs/replace','info','objects','objects/info','objects/pack']:
        if indirect(gitdir/name):raise ValueError('metadata parent indirection prohibited')
    for name in ['commondir','shallow','info/grafts','objects/info/alternates','objects/info/http-alternates','config.worktree']:
        if os.path.lexists(gitdir/name):raise ValueError('unsafe Git metadata indirection')
    config=gitdir/'config'
    if indirect(config) or not config.is_file() or config.stat().st_size>65536:
        raise ValueError('bounded local Git configuration required')
    raw=config.read_bytes()
    # Reject indirection before Git is started, including includeIf/partial clone.
    if re.search(rb'(?im)^\s*\[\s*include|\bpromisor\s*=|\bpartialclone\s*=|\bworktreeconfig\s*=|\balternate',raw):
        raise ValueError('unsupported Git configuration indirection')
    replacements=gitdir/'refs/replace'
    if replacements.exists() and any(replacements.iterdir()):raise ValueError('replacement objects prohibited')
    packed=gitdir/'packed-refs'
    if packed.exists():
        if indirect(packed) or packed.stat().st_size>1024*1024:raise ValueError('unsafe packed refs')
        if b' refs/replace/' in packed.read_bytes():raise ValueError('replacement objects prohibited')
    count=0
    def scan(path,depth=0):
        nonlocal count
        if indirect(path) or depth>4:raise ValueError('object metadata symlink or depth prohibited')
        with os.scandir(path) as entries:
            for item in entries:
                count+=1
                if count>MAX_METADATA_ENTRIES or indirect(Path(item.path)) or item.name.endswith('.promisor'):
                    raise ValueError('unsafe or oversized object metadata')
                if item.is_dir(follow_symlinks=False):scan(Path(item.path),depth+1)
                elif not item.is_file(follow_symlinks=False):raise ValueError('nonregular object metadata')
    scan(gitdir/'objects')
    return raw


def read_git_base(git_binary,repository,commit):
    executable=Path(git_binary);root=Path(repository)
    if (not executable.is_absolute() or not executable.is_file() or not root.is_absolute()
        or not root.is_dir() or os.path.normcase(str(root.resolve()))!=os.path.normcase(os.path.abspath(root))
        or type(commit) is not str or re.fullmatch('[a-f0-9]{40}',commit) is None):
        raise ValueError('absolute trusted Git/repository and exact SHA-1 commit required')
    config_before=safe_metadata(root)
    env={key:os.environ[key] for key in ['SYSTEMROOT','WINDIR'] if key in os.environ}
    env.update({'PATH':str(executable.parent)+os.pathsep+os.defpath,'GIT_CONFIG_NOSYSTEM':'1',
        'GIT_CONFIG_SYSTEM':os.devnull,'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_COUNT':'0',
        'GIT_NO_REPLACE_OBJECTS':'1','GIT_NO_LAZY_FETCH':'1','GIT_OPTIONAL_LOCKS':'0',
        'GIT_TERMINAL_PROMPT':'0','GIT_ATTR_NOSYSTEM':'1','LC_ALL':'C','LANG':'C'})
    deadline=time.monotonic()+20
    prefix=[str(executable),'--no-replace-objects','--no-lazy-fetch','--git-dir='+str(root/'.git'),
        '-c','core.fsmonitor=false','-c','core.hooksPath='+os.devnull,'-c','credential.helper=',
        '-c','protocol.allow=never']
    def command(parts,limit=4096,input_bytes=None,allowed=(0,)):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise ValueError('base reader process budget exceeded')
        try:
            code,output=capture(prefix+parts,min(3,remaining),limit=limit,input_bytes=input_bytes,env=env)
        except Exception:
            raise ValueError('bounded Git read failed') from None
        if code not in allowed:raise ValueError('Git object or metadata unavailable')
        return output
    if command(['rev-parse','--show-object-format']).strip()!=b'sha1':raise ValueError('SHA-1 repository required')
    origin_raw=command(['config','--local','--no-includes','--get','remote.origin.url'],1024,allowed=(0,1))
    origin=origin_raw.decode('ascii').strip() or None
    allowed_remotes={f'https://github.com/{REMOTE}',f'https://github.com/{REMOTE}.git',f'git@github.com:{REMOTE}',f'git@github.com:{REMOTE}.git'}
    if origin is not None and origin not in allowed_remotes:raise ValueError('foreign or credential-bearing remote prohibited')
    consumed=0
    def object_bytes(oid,kind,bound):
        nonlocal consumed
        if command(['cat-file','-t',oid],64)!=kind.encode()+b'\n':raise ValueError('unexpected Git object type')
        size_raw=command(['cat-file','-s',oid],64)
        if re.fullmatch(b'[0-9]+\n',size_raw) is None:raise ValueError('invalid Git object size')
        size=int(size_raw)
        if size>bound or consumed+size>MAX_TOTAL+1024*1024:raise ValueError('Git object allocation bound')
        raw=command(['cat-file',kind,oid],size+4096)
        if len(raw)!=size:raise ValueError('incomplete Git object bytes')
        consumed+=size
        return raw
    raw_commit=object_bytes(commit,'commit',MAX_COMMIT)
    if command(['hash-object','-t','commit','--stdin','--no-filters'],64,input_bytes=raw_commit).strip().decode('ascii')!=commit:
        raise ValueError('base commit object hash mismatch')
    header=raw_commit.partition(b'\n\n')[0].splitlines()
    if (not header or re.fullmatch(b'tree [a-f0-9]{40}',header[0]) is None
        or sum(line.startswith(b'tree ') for line in header)!=1):raise ValueError('base commit tree header rejected')
    tree=header[0][5:].decode('ascii');files=[];entries_seen=0;content_bytes=0
    def walk(oid,prefix_path='',depth=0):
        nonlocal entries_seen,content_bytes
        if depth>12:raise ValueError('Git tree depth bound')
        raw=object_bytes(oid,'tree',min(MAX_TOTAL,MAX_FILES*300));offset=0
        while offset<len(raw):
            zero=raw.find(b'\0',offset)
            if zero<0 or zero-offset>300 or zero+21>len(raw):raise ValueError('malformed complete tree')
            record=raw[offset:zero].split(b' ',1)
            if len(record)!=2:raise ValueError('malformed tree record')
            mode,name=record
            try:path=valid_path(prefix_path+name.decode('ascii'))
            except Exception:raise ValueError('unsupported committed path') from None
            child=raw[zero+1:zero+21].hex();offset=zero+21;entries_seen+=1
            if entries_seen>MAX_FILES*13:raise ValueError('Git tree entry bound')
            if mode==b'40000':walk(child,path+'/',depth+1)
            elif mode in [b'100644',b'100755']:
                if len(files)>=MAX_FILES:raise ValueError('base file count bound')
                content=object_bytes(child,'blob',MAX_FILE);content_bytes+=len(content)
                if content_bytes>MAX_TOTAL:raise ValueError('base aggregate bound')
                files.append(SnapshotFile(path,mode.decode('ascii'),content))
            else:raise ValueError('symlink, gitlink or unsupported mode prohibited')
    walk(tree)
    snapshot=tuple(sorted(files,key=lambda item:item.path))
    if build_git_objects(snapshot,expected_format='sha1').root_tree!=tree:raise ValueError('complete committed root tree mismatch')
    manifest=hashlib.sha256(snapshot_manifest(snapshot).encode('ascii')).hexdigest()
    frame=encode_frame(snapshot,expected_manifest_hash=manifest,expected_tree=tree)
    if safe_metadata(root)!=config_before:raise ValueError('Git configuration changed during capture')
    result={'version':1,'baseCommit':commit,'sourceTree':tree,'manifestHash':manifest,
        'frameBase64':base64.b64encode(frame).decode('ascii'),'origin':origin}
    encode_result(result)
    return result


if __name__=='__main__':
    try:
        if len(sys.argv)!=4:raise ValueError('three fixed arguments required')
        sys.stdout.buffer.write(encode_result(read_git_base(*sys.argv[1:]))+b'\n')
    except Exception:
        raise SystemExit('Committed base not verified; no repository changes performed.') from None
