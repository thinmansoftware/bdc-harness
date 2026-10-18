"""Readonly Linux volume exporter. Caller supplies the process/storage barrier.

No snapshot immutability claim: previously submitted asynchronous I/O is outside
this prototype's qualification. Source must stay paused and exclusively owned.
"""
import io
import errno
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tarfile

# The image helper directory is immutable and outside the model volume.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from teetime_snapshot import MAX_ARCHIVE, MAX_FILE, MAX_FILES, MAX_TOTAL, read_snapshot, valid_path

MAGIC = b'TTSNAP1\n'
MAX_HEADER = 65536
MAX_FRAME = len(MAGIC)+12+MAX_HEADER+MAX_ARCHIVE
FIXTURE_SCOPE = ('.gitignore', 'counter.txt', 'ignored.tmp', 'src/new.txt')
MASKS = ('.codex', '.agents')
REJECT_MAGIC = b'TTSNAPREJECT1\n'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def checked_scope(paths):
    if type(paths) not in [tuple, list] or len(paths) > MAX_FILES:
        raise ValueError('invalid permitted scope')
    result = tuple(valid_path(path) for path in paths)
    if len({path.casefold() for path in result}) != len(result):
        raise ValueError('duplicate permitted scope')
    return frozenset(result)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def bounded_names(descriptor, limit):
    names = []
    with os.scandir(descriptor) as entries:
        for entry in entries:
            if len(names) >= limit:
                raise ValueError('directory inventory bound')
            names.append(entry.name)
    return names


def export_snapshot(root, permitted_paths):
    if os.name != 'posix' or os.open not in os.supports_dir_fd:
        raise ValueError('Linux descriptor traversal required')
    permitted = checked_scope(permitted_paths)
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    root_fd = os.open(root, flags | os.O_DIRECTORY)
    files = []
    total = entries = 0
    try:
        root_device = os.fstat(root_fd).st_dev

        def walk(parent, prefix):
            nonlocal total, entries
            before = os.fstat(parent)
            if before.st_dev != root_device:
                raise ValueError('cross-device directory')
            names = bounded_names(parent, 1024-entries)
            entries += len(names)
            if entries > 1024:
                raise ValueError('directory inventory bound')
            if not prefix and not set(MASKS).issubset(names):
                raise ValueError('missing underlying metadata directory')
            for name in sorted(names):
                path = prefix+'/'+name if prefix else name
                is_mask = not prefix and name in MASKS
                if not is_mask:
                    valid_path(path)
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if info.st_dev != root_device:
                    raise ValueError('cross-device entry')
                if stat.S_ISDIR(info.st_mode):
                    if not is_mask and not any(item.startswith(path+'/') for item in permitted):
                        raise ValueError('directory outside permitted project scope')
                    child = os.open(name, flags | os.O_DIRECTORY, dir_fd=parent)
                    try:
                        if identity(os.fstat(child)) != identity(info):
                            raise ValueError('directory changed before opening')
                        if is_mask:
                            with os.scandir(child) as children:
                                if next(children, None) is not None:
                                    raise ValueError('hidden metadata contents')
                        else:
                            walk(child, path)
                        if identity(os.fstat(child)) != identity(info):
                            raise ValueError('directory changed while reading')
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode) and not is_mask:
                    if path not in permitted or info.st_nlink != 1 or info.st_size > MAX_FILE:
                        raise ValueError('unsupported file or scope')
                    if len(files) >= MAX_FILES or total+info.st_size > MAX_TOTAL or info.st_mode & 0o7000:
                        raise ValueError('file bound or special mode')
                    child = os.open(name, flags | os.O_NONBLOCK, dir_fd=parent)
                    try:
                        if identity(os.fstat(child)) != identity(info):
                            raise ValueError('file changed before opening')
                        chunks = bytearray()
                        while len(chunks) <= info.st_size:
                            chunk = os.read(child, min(65536, info.st_size+1-len(chunks)))
                            if not chunk:
                                break
                            chunks.extend(chunk)
                        if len(chunks) != info.st_size or identity(os.fstat(child)) != identity(info):
                            raise ValueError('file changed while reading')
                        total += len(chunks)
                        files.append((path, bytes(chunks), 0o755 if info.st_mode & 0o111 else 0o644))
                    finally:
                        os.close(child)
                else:
                    raise ValueError('nonregular volume entry')
            if identity(os.fstat(parent)) != identity(before):
                raise ValueError('directory changed during traversal')

        walk(root_fd, '')
    finally:
        os.close(root_fd)
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path, content, mode in sorted(files):
            item = tarfile.TarInfo(path)
            item.size = len(content)
            item.mode = mode
            archive.addfile(item, io.BytesIO(content))
    raw = output.getvalue()
    inventory = tuple(path for path, _, _ in sorted(files))
    read_snapshot(raw, inventory)
    header = canonical({'version': 1, 'inventory': inventory})
    if len(header) > MAX_HEADER or len(raw) > MAX_ARCHIVE:
        raise ValueError('export frame bound')
    return MAGIC+struct.pack('!IQ', len(header), len(raw))+header+raw


def decode_frame(raw, permitted_paths):
    permitted = checked_scope(permitted_paths)
    offset = len(MAGIC)+12
    if type(raw) is not bytes or not offset <= len(raw) <= MAX_FRAME or not raw.startswith(MAGIC):
        raise ValueError('invalid export framing')
    header_size, archive_size = struct.unpack('!IQ', raw[len(MAGIC):offset])
    if not 1 <= header_size <= MAX_HEADER or not 1024 <= archive_size <= MAX_ARCHIVE:
        raise ValueError('invalid export frame lengths')
    if len(raw) != offset+header_size+archive_size:
        raise ValueError('incomplete or trailing export frame')
    header_bytes = raw[offset:offset+header_size]
    try:
        header = json.loads(header_bytes)
    except (ValueError, UnicodeError) as error:
        raise ValueError('invalid export inventory') from error
    if (type(header) is not dict or set(header) != {'version', 'inventory'}
            or type(header['version']) is not int or header['version'] != 1
            or canonical(header) != header_bytes):
        raise ValueError('invalid canonical inventory')
    paths = checked_scope(header['inventory'])
    inventory = tuple(header['inventory'])
    if inventory != tuple(sorted(paths)) or not paths.issubset(permitted):
        raise ValueError('inventory outside permitted scope or order')
    archive = raw[offset+header_size:]
    read_snapshot(archive, inventory)
    return inventory, archive


if __name__ == '__main__':
    try:
        if sys.argv[1:] != ['--fixture']:
            raise ValueError('only the fixed qualification scope is supported')
        try:
            descriptor = os.open('/workspace/.readonly-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except OSError as error:
            if error.errno != errno.EROFS:
                raise ValueError('readonly volume verification failed') from None
        else:
            os.close(descriptor)
            raise ValueError('export volume was writable')
        sys.stdout.buffer.write(export_snapshot('/workspace', FIXTURE_SCOPE))
    except ValueError as error:
        category = {'hidden metadata contents': 'shadow', 'nonregular volume entry': 'entry',
                    'unsupported file or scope': 'scope'}.get(str(error), 'invalid')
        sys.stdout.buffer.write(REJECT_MAGIC+canonical({'rejected': category}))
        raise SystemExit(2) from None
    except Exception:
        raise SystemExit('snapshot export rejected') from None
