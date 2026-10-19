"""Artifact-only workspace confinement. Never returns names or file contents."""
import errno
import os
from pathlib import Path
import stat

MASKS = ('.agents', '.codex')
WORKSPACE_CATEGORIES = ('unchanged', 'inventory_changed', 'mask_type_changed',
                        'mask_metadata_changed', 'mask_not_empty', 'inspection_failed')


def worker_tmpfs(artifact):
    if type(artifact) is not bool:
        raise ValueError('closed worker mode required')
    paths = {'/home/appuser': 'uid=1001,gid=1001,size=64m',
             '/tmp': 'uid=1001,gid=1001,size=64m'}
    if not artifact:
        paths['/workspace'] = 'uid=1001,gid=1001,size=64m'
    for name in MASKS:
        paths['/workspace/'+name] = 'ro,uid=1001,gid=1001,size=1m'
    return paths


def workspace_diagnostic(root, before, uid):
    result = {'category': 'inspection_failed', 'entryCount': 0, 'maskEntryCount': 0}
    try:
        if before is None:
            return result
        entries = []
        for entry in Path(root).iterdir():
            entries.append(entry)
            if len(entries) >= 17:
                break
        result['entryCount'] = len(entries)
        if sorted(path.name for path in entries) != list(MASKS):
            return {**result, 'category': 'inventory_changed'}
        records = []
        for path in sorted(entries, key=lambda item: item.name):
            info = path.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
                return {**result, 'category': 'mask_type_changed'}
            count = 0
            for _ in path.iterdir():
                count += 1
                if count >= 17:
                    break
            result['maskEntryCount'] = min(17, result['maskEntryCount'] + count)
            if count:
                return {**result, 'category': 'mask_not_empty'}
            records.append((path.name, info.st_mode, info.st_uid, info.st_gid, info.st_dev, info.st_ino))
        result['category'] = 'unchanged' if tuple(records) == before else 'mask_metadata_changed'
        return result
    except Exception:
        return result


def require_readonly_workspace(root):
    """Called on the isolated worker before READY/account delivery."""
    root = Path(root)
    result = {}
    probe = root/'.teetime-write-denial-probe'
    try:
        descriptor = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        if error.errno != errno.EROFS:
            raise ValueError('workspace write denial not verified') from None
        result['write'] = 'EROFS'
    else:
        os.close(descriptor)
        probe.unlink()
        raise ValueError('artifact workspace was writable')
    probe = root/'.teetime-create-denial-probe'
    try:
        os.mkdir(probe)
    except OSError as error:
        if error.errno != errno.EROFS:
            raise ValueError('workspace create denial not verified') from None
        result['create'] = 'EROFS'
    else:
        probe.rmdir()
        raise ValueError('artifact workspace allowed creation')
    try:
        os.rename(root/'.agents', root/'.teetime-rename-denial-probe')
    except OSError as error:
        if error.errno not in (errno.EROFS, errno.EBUSY):
            raise ValueError('workspace rename denial not verified') from None
        result['rename'] = 'EROFS' if error.errno == errno.EROFS else 'EBUSY'
    else:
        raise ValueError('artifact workspace allowed rename')
    return result
