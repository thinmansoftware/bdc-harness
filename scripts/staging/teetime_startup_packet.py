"""Private synthetic startup data; public output is a closed metadata projection."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat

from teetime_artifact_contract import unique_object, reject_constant


FIELDS = {'kind','steps','threadCreated','rpcError','binaryHash','sourceFixtureHash',
          'catalogHash','authUnchanged','catalogUnchanged','childReaped','modelTurnsSent'}
SOURCE_HASH = '59f2bbc19bce43c67d6f1cdd99886953a256d948788d85810c774b17375c1fb6'


def startup_metadata(raw):
    if type(raw) is not bytes or not 1 <= len(raw) <= 65536:
        raise ValueError('startup packet byte bound')
    try:
        value=json.loads(raw.decode('utf-8'),object_pairs_hook=unique_object,parse_constant=reject_constant)
    except (ValueError,UnicodeError,RecursionError):
        raise ValueError('startup packet JSON rejected') from None
    nodes=0
    def bounded(item,depth=0):
        nonlocal nodes
        nodes+=1
        if depth>32 or nodes>32768 or (type(item) is float and not math.isfinite(item)):
            raise ValueError('startup packet structure bound')
        if type(item) is str:
            try: item.encode('utf-8')
            except UnicodeError: raise ValueError('startup packet string encoding') from None
        if type(item) is dict:
            for key,child in item.items():
                bounded(key,depth+1)
                bounded(child,depth+1)
        elif type(item) is list:
            for child in item: bounded(child,depth+1)
    bounded(value)
    if (type(value) is not dict or set(value)!=FIELDS or value['kind']!='teetime-thread-start-debug-v1'
            or value['steps']!=['initialize','initialized','thread/start']
            or type(value['threadCreated']) is not bool or type(value['modelTurnsSent']) is not int
            or value['modelTurnsSent']!=0):
        raise ValueError('startup packet protocol rejected')
    for key in ('authUnchanged','catalogUnchanged','childReaped'):
        if value[key] is not True: raise ValueError('startup packet input or cleanup mismatch')
    for key in ('binaryHash','catalogHash','sourceFixtureHash'):
        if type(value[key]) is not str or re.fullmatch('[a-f0-9]{64}',value[key]) is None:
            raise ValueError('startup packet identity rejected')
    if value['sourceFixtureHash']!=SOURCE_HASH: raise ValueError('startup packet source rejected')
    error=value['rpcError']
    if value['threadCreated']:
        if error is not None: raise ValueError('startup packet contradictory result')
        code=None
    else:
        if (type(error) is not dict or set(error) not in ({'code','message'},{'code','message','data'})
                or type(error['code']) is not int or not -2147483648 <= error['code'] <= 2147483647
                or type(error['message']) is not str):
            raise ValueError('startup packet error shape')
        try:
            size=len(error['message'].encode('utf-8'))
        except UnicodeError:
            raise ValueError('startup packet error encoding') from None
        if not 1 <= size <= 32768: raise ValueError('startup packet error message bound')
        code=error['code']
    return {'kind':'teetime-thread-start-metadata-v1','sha256':hashlib.sha256(raw).hexdigest(),
            'bytes':len(raw),'rpcCode':code,'threadCreated':value['threadCreated'],
            'binaryHash':value['binaryHash'],'sourceFixtureHash':value['sourceFixtureHash'],
            'catalogHash':value['catalogHash'],'modelTurnsSent':0}


def write_private_packet(root,owner,raw):
    # Trusted parent precondition: a fresh runner-owned parent, not exposed to the
    # container or concurrent untrusted host actors. These checks do not defend
    # against an actor replacing ancestor directories in a shared filesystem.
    startup_metadata(raw)
    if re.fullmatch('teetime-startup-[0-9]+-[0-9]+',owner or '') is None:
        raise ValueError('startup private owner rejected')
    if os.name!='posix': raise RuntimeError('startup private storage requires qualified POSIX permissions')
    root=Path(root)
    if (not root.is_absolute() or root.is_symlink() or not root.is_dir()
            or root.absolute()!=root.resolve(strict=True)):
        raise ValueError('startup private root rejected')
    directory=root/owner
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        raise ValueError('startup private directory already exists') from None
    info=directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o700 or info.st_uid!=os.getuid()):
        raise ValueError('startup private directory ownership mismatch')
    destination=directory/'thread-start-error.json'
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW
    descriptor=os.open(destination,flags,0o600)
    with os.fdopen(descriptor,'wb') as output:
        info=os.fstat(output.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=os.getuid()):
            raise ValueError('startup private file ownership mismatch')
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    if destination.read_bytes()!=raw: raise ValueError('startup private storage identity mismatch')
    return destination


def read_private_metadata(root,owner):
    if re.fullmatch('teetime-startup-[0-9]+-[0-9]+',owner or '') is None:
        raise ValueError('startup private owner rejected')
    if os.name!='posix': raise RuntimeError('startup private storage requires qualified POSIX permissions')
    root=Path(root)
    if not root.is_absolute() or root.is_symlink() or root.absolute()!=root.resolve(strict=True):
        raise ValueError('startup private root rejected')
    directory=root/owner
    info=directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o700 or info.st_uid!=os.getuid()
            or set(os.listdir(directory))!={'thread-start-error.json'}):
        raise ValueError('startup private directory rejected')
    descriptor=os.open(directory/'thread-start-error.json',os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(descriptor,'rb') as source:
        info=os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600
                or info.st_uid!=os.getuid() or info.st_nlink!=1 or not 1<=info.st_size<=65536):
            raise ValueError('startup private upload file rejected')
        raw=source.read(65537)
        after=os.fstat(source.fileno())
        stable=('st_dev','st_ino','st_mode','st_uid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        if any(getattr(info,key)!=getattr(after,key) for key in stable) or len(raw)!=info.st_size:
            raise ValueError('startup private upload file changed')
    return startup_metadata(raw)
