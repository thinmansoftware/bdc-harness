"""Pure bounded Git objects from a complete, unchanged validated snapshot.

Caller supplies read_snapshot output and proves inventory custody/quiescence.
This module cannot authenticate input provenance and grants no approval authority.
It never scans a directory, invokes Git, creates commits/refs or extracts files.
"""
from dataclasses import dataclass
import hashlib

from teetime_snapshot import MAX_FILE, MAX_FILES, MAX_TOTAL, SnapshotFile, valid_path

MAX_OBJECTS = MAX_FILES * 13 + 1
MAX_OBJECT_BYTES = MAX_TOTAL + 1024 * 1024


@dataclass(frozen=True)
class GitObject:
    oid: str
    kind: str
    payload: bytes


@dataclass(frozen=True)
class GitSnapshot:
    root_tree: str
    objects: tuple[GitObject, ...]


def build_git_objects(files, *, expected_format):
    """Construct SHA-1 blobs/trees; files represent the entire candidate, not a diff."""
    if expected_format != 'sha1':
        raise ValueError('unsupported expected Git object format')
    if type(files) is not tuple or len(files) > MAX_FILES:
        raise ValueError('immutable bounded snapshot required')
    root = {}
    prefixes = {}
    total = 0
    for file in files:
        if type(file) is not SnapshotFile or file.git_mode not in ['100644', '100755']:
            raise ValueError('invalid snapshot record')
        if type(file.content) is not bytes or len(file.content) > MAX_FILE:
            raise ValueError('immutable bounded file required')
        total += len(file.content)
        if total > MAX_TOTAL:
            raise ValueError('snapshot total bound')
        parts = valid_path(file.path).split('/')
        node = root
        for index, name in enumerate(parts):
            prefix = '/'.join(parts[:index+1])
            folded = prefix.casefold()
            if folded in prefixes and prefixes[folded] != prefix:
                raise ValueError('case-colliding snapshot paths')
            prefixes[folded] = prefix
            if index == len(parts)-1:
                if name in node:
                    raise ValueError('duplicate or file-directory collision')
                node[name] = file
            else:
                child = node.setdefault(name, {})
                if type(child) is not dict:
                    raise ValueError('file-directory collision')
                node = child

    objects = {}
    object_bytes = 0

    def add(kind, payload):
        nonlocal object_bytes
        header = kind.encode('ascii')+b' '+str(len(payload)).encode('ascii')+b'\0'
        oid = hashlib.sha1(header+payload).hexdigest()
        item = GitObject(oid, kind, payload)
        if oid in objects:
            if objects[oid] != item:
                raise ValueError('Git object identity collision')
            return oid
        object_bytes += len(header)+len(payload)
        if len(objects) >= MAX_OBJECTS or object_bytes > MAX_OBJECT_BYTES:
            raise ValueError('Git object output bound')
        objects[oid] = item
        return oid

    def tree(node):
        entries = []
        # Git compares a tree name as though a slash followed its last byte.
        for name, child in sorted(node.items(), key=lambda pair:
                                  pair[0].encode('ascii')+(b'/' if type(pair[1]) is dict else b'\0')):
            directory = type(child) is dict
            oid = tree(child) if directory else add('blob', child.content)
            mode = '40000' if directory else child.git_mode
            entries.append(mode.encode('ascii')+b' '+name.encode('ascii')+b'\0'+bytes.fromhex(oid))
        return add('tree', b''.join(entries))

    root_tree = tree(root)
    return GitSnapshot(root_tree, tuple(objects[oid] for oid in sorted(objects)))
