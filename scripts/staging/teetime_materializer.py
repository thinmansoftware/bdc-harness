"""Trusted synchronous writer only. Caller owns exclusive new volume and disposal."""
import argparse
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from teetime_materialization_frame import MAX_FRAME, decode_frame


def materialize(root, raw, *, expected_manifest_hash, expected_tree):
    # All data validation precedes any filesystem entry creation.
    files = decode_frame(raw, expected_manifest_hash=expected_manifest_hash, expected_tree=expected_tree)
    if os.name != 'posix' or os.getuid() != 1001 or os.open not in os.supports_dir_fd:
        raise ValueError('isolated Linux UID1001 writer required')
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_DIRECTORY
    root_fd = os.open(root, flags)
    directories = {'': root_fd}
    try:
        info = os.fstat(root_fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 1001:
            raise ValueError('ordinary owned root required')
        with os.scandir(root_fd) as entries:
            if next(entries, None) is not None:
                raise ValueError('new empty root required; discard partial materialization')
        for file in files:
            parts = file.path.split('/')
            prefix = ''
            for name in parts[:-1]:
                parent = directories[prefix]
                prefix = prefix+'/'+name if prefix else name
                if prefix not in directories:
                    os.mkdir(name, 0o700, dir_fd=parent)
                    child = os.open(name, flags, dir_fd=parent)
                    directories[prefix] = child
                    os.fchmod(child, 0o755)
            descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                 0o600, dir_fd=directories[prefix])
            try:
                remaining = memoryview(file.content)
                while remaining:
                    size = os.write(descriptor, remaining)
                    if size <= 0:
                        raise OSError('incomplete synchronous materialization')
                    remaining = remaining[size:]
                os.fchmod(descriptor, 0o755 if file.git_mode == '100755' else 0o644)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        for prefix in sorted(directories, key=lambda value: (value.count('/'), len(value)), reverse=True):
            os.fsync(directories[prefix])
    finally:
        for descriptor in reversed(tuple(directories.values())):
            os.close(descriptor)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest-hash', required=True)
    parser.add_argument('--source-tree', required=True)
    args = parser.parse_args()
    if not __debug__:
        raise SystemExit('assertion-enabled Python required')
    raw = sys.stdin.buffer.read(MAX_FRAME+1)
    materialize('/candidate', raw, expected_manifest_hash=args.manifest_hash, expected_tree=args.source_tree)
    # A process exit/receipt does not prove removal or authorize testing/publication.
    print('materialization-complete', flush=True)
