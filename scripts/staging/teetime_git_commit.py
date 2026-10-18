"""Pure commit object candidate, never a repository head or approval authority."""
from dataclasses import dataclass
import hashlib
import re

from teetime_git_objects import GitObject, MAX_OBJECT_BYTES, MAX_OBJECTS, build_git_objects

MAX_MESSAGE_BYTES = 4096
MAX_TIMESTAMP = 9999999999


@dataclass(frozen=True)
class CommitIdentity:
    name: str
    email: str


def build_candidate_commit(files, *, expected_format, parent_commit, identity, timestamp, message):
    """Caller freezes identity/time/message and proves parent/base custody separately."""
    if type(parent_commit) is not str or re.fullmatch('[a-f0-9]{40}', parent_commit) is None:
        raise ValueError('one explicit SHA-1 parent required')
    if type(identity) is not CommitIdentity:
        raise ValueError('immutable separate identity fields required')
    for value, limit in [(identity.name, 80), (identity.email, 254)]:
        if (type(value) is not str or not 1 <= len(value) <= limit or value != value.strip()
                or any(not 32 <= ord(char) <= 126 or char in '<>' for char in value)):
            raise ValueError('bounded ASCII identity without header delimiters required')
    if re.fullmatch(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', identity.email) is None:
        raise ValueError('unambiguous email without whitespace required')
    if type(timestamp) is not int or not 0 <= timestamp <= MAX_TIMESTAMP:
        raise ValueError('bounded nonboolean timestamp required')
    if (type(message) is not bytes or not 1 <= len(message) <= MAX_MESSAGE_BYTES
            or not message.endswith(b'\n') or any(byte not in [9, 10] and not 32 <= byte <= 126 for byte in message)):
        raise ValueError('bounded exact ASCII message ending in LF required')
    snapshot = build_git_objects(files, expected_format=expected_format)
    person = identity.name+' <'+identity.email+'> '+str(timestamp)+' +0000'
    payload = ('tree '+snapshot.root_tree+'\nparent '+parent_commit+'\nauthor '+person+
               '\ncommitter '+person+'\n\n').encode('ascii')+message
    encoded = b'commit '+str(len(payload)).encode('ascii')+b'\0'+payload
    commit = GitObject(hashlib.sha1(encoded).hexdigest(), 'commit', payload)
    for item in snapshot.objects:
        if item.oid == commit.oid and item != commit:
            raise ValueError('Git commit object identity collision')
    objects = {item.oid: item for item in (*snapshot.objects, commit)}
    total = sum(len(item.kind)+1+len(str(len(item.payload)))+1+len(item.payload) for item in objects.values())
    if len(objects) > MAX_OBJECTS or total > MAX_OBJECT_BYTES:
        raise ValueError('commit exceeds aggregate Git object output bound')
    return snapshot, commit
