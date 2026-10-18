"""Pure bounded USTAR validation. Never extract model-controlled archive members."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import PurePosixPath
import re

MAX_ARCHIVE = 16 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024
MAX_FILE = 1024 * 1024
MAX_FILES = 128
RESERVED = {'CON', 'PRN', 'AUX', 'NUL', *('COM'+str(n) for n in range(1, 10)),
            *('LPT'+str(n) for n in range(1, 10))}


@dataclass(frozen=True)
class SnapshotFile:
    path: str
    git_mode: str
    content: bytes

    @property
    def sha256(self):
        return hashlib.sha256(self.content).hexdigest()


def valid_path(value):
    if not isinstance(value, str) or not 0 < len(value) <= 255:
        raise ValueError('invalid snapshot path')
    if not re.fullmatch('[a-zA-Z0-9_./-]+', value):
        raise ValueError('unsupported snapshot path')
    parts = value.split('/')
    if len(parts) > 12 or any(part in ['', '.', '..'] or part.endswith('.') for part in parts):
        raise ValueError('noncanonical snapshot path')
    if str(PurePosixPath(value)) != value or PurePosixPath(value).is_absolute():
        raise ValueError('unsafe snapshot path')
    for part in parts:
        if part.split('.')[0].upper() in RESERVED:
            raise ValueError('reserved snapshot path')
        if part.casefold() in ['.git', '.codex', '.agents']:
            raise ValueError('metadata or instruction path in snapshot')
        if part.casefold() == '.env' or part.casefold().startswith('.env.') and part != '.env.example':
            raise ValueError('credential path in snapshot')
    return value


def octal(field):
    text = field.rstrip(b'\0 ').lstrip(b' ')
    if not text or not re.fullmatch(b'[0-7]+', text):
        raise ValueError('unsupported tar numeric field')
    return int(text, 8)


def string_field(field):
    value, _, padding = field.partition(b'\0')
    if padding.strip(b'\0'):
        raise ValueError('nonzero tar string padding')
    return value.decode('ascii')


def read_snapshot(raw, approved_paths):
    """Require the trusted exact candidate inventory, not a deletion-permitting allowlist.

    Caller proves inventory custody, scope, quiescence and mask emptiness separately.
    """
    if not isinstance(raw, bytes) or not 1024 <= len(raw) <= MAX_ARCHIVE or len(raw) % 512:
        raise ValueError('snapshot archive bound')
    approved = {valid_path(path) for path in approved_paths}
    if len(approved) != len(approved_paths) or len(approved) > MAX_FILES:
        raise ValueError('invalid approved snapshot paths')
    folded_approved = [path.casefold() for path in approved]
    if len(set(folded_approved)) != len(folded_approved):
        raise ValueError('approved path case collision')
    prefixes = {}
    for path in sorted(approved):
        parts = path.split('/')
        for index in range(1, len(parts)+1):
            prefix = '/'.join(parts[:index])
            folded = prefix.casefold()
            if folded in prefixes and prefixes[folded] != prefix:
                raise ValueError('directory case collision')
            if index < len(parts) and folded in folded_approved:
                raise ValueError('file-directory path collision')
            prefixes[folded] = prefix
    files = []
    seen = set()
    offset = total = 0
    while offset+512 <= len(raw):
        header = raw[offset:offset+512]
        offset += 512
        if not any(header):
            if len(raw)-offset < 512 or any(raw[offset:]):
                raise ValueError('invalid archive terminator')
            if seen != {path.casefold() for path in approved}:
                raise ValueError('incomplete snapshot inventory')
            return tuple(sorted(files, key=lambda item: item.path))
        if header[257:263] != b'ustar\0' or header[263:265] != b'00':
            raise ValueError('unsupported tar format')
        checksum = sum(header[:148])+8*32+sum(header[156:])
        if octal(header[148:156]) != checksum:
            raise ValueError('tar checksum mismatch')
        if header[156:157] not in [b'0', b'\0'] or any(header[157:257]):
            raise ValueError('nonregular tar member')
        prefix = string_field(header[345:500])
        name = string_field(header[:100])
        path = valid_path(prefix+'/'+name if prefix else name)
        if path not in approved or path.casefold() in seen:
            raise ValueError('unexpected or duplicate snapshot file')
        seen.add(path.casefold())
        size = octal(header[124:136])
        mode = octal(header[100:108])
        if mode & ~0o777 or size > MAX_FILE or total+size > MAX_TOTAL or len(files) >= MAX_FILES:
            raise ValueError('snapshot member bound or unsupported mode')
        padded = ((size+511)//512)*512
        if offset+padded > len(raw) or any(raw[offset+size:offset+padded]):
            raise ValueError('truncated or invalid file padding')
        files.append(SnapshotFile(path, '100755' if mode & 0o111 else '100644', raw[offset:offset+size]))
        total += size
        offset += padded
    raise ValueError('missing archive terminator')


def snapshot_manifest(files):
    """Serialize only unchanged validated read_snapshot output; not an input validator."""
    paths = [file.path for file in files]
    if len(set(paths)) != len(paths):
        raise ValueError('duplicate manifest path')
    return json.dumps({'version': 1, 'files': [
        {'path': file.path, 'mode': file.git_mode, 'size': len(file.content), 'sha256': file.sha256}
        for file in sorted(files, key=lambda item: item.path)
    ]}, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
