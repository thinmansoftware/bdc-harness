"""Image-owned provenance fixture; never imports or executes candidate source."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from teetime_git_objects import build_git_objects
from teetime_materialization_frame import MAX_FRAME, decode_frame, verify
from teetime_snapshot import SnapshotFile, snapshot_manifest

COMMAND_ID = 'teetime-materialization-provenance-v1'
PROBE = '.materialization-readonly-probe'


def read_candidate(root, *, expected_files, expected_manifest_hash, expected_tree):
    verify(expected_files, expected_manifest_hash, expected_tree)
    if os.name != 'posix' or os.open not in os.supports_dir_fd:
        raise ValueError('Linux descriptor traversal required')
    expected = {file.path: file for file in expected_files}
    prefixes = {path.rsplit('/', 1)[0] for path in expected if '/' in path}
    prefixes |= {'/'.join(path.split('/')[:index]) for path in expected
                 for index in range(1, len(path.split('/')))}
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    root_fd = os.open(root, flags | os.O_DIRECTORY)
    files = []
    entries_seen = 0
    try:
        device = os.fstat(root_fd).st_dev

        def walk(parent, prefix):
            nonlocal entries_seen
            with os.scandir(parent) as entries:
                for entry in entries:
                    entries_seen += 1
                    if entries_seen > 1536:
                        raise ValueError('candidate inventory bound')
                    path = prefix+'/'+entry.name if prefix else entry.name
                    info = os.stat(entry.name, dir_fd=parent, follow_symlinks=False)
                    if info.st_dev != device or info.st_mode & 0o7000:
                        raise ValueError('candidate device or special-mode mismatch')
                    if stat.S_ISDIR(info.st_mode) and path in prefixes:
                        child = os.open(entry.name, flags | os.O_DIRECTORY, dir_fd=parent)
                        try:
                            walk(child, path)
                        finally:
                            os.close(child)
                    elif stat.S_ISREG(info.st_mode) and path in expected:
                        wanted = expected[path]
                        mode = 0o755 if wanted.git_mode == '100755' else 0o644
                        if info.st_nlink != 1 or info.st_size != len(wanted.content) or info.st_mode & 0o777 != mode:
                            raise ValueError('candidate size, mode or link mismatch')
                        child = os.open(entry.name, flags | os.O_NONBLOCK, dir_fd=parent)
                        try:
                            opened = os.fstat(child)
                            if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink, opened.st_size) != (
                                    info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size):
                                raise ValueError('candidate changed before opening')
                            content = bytearray()
                            while len(content) <= len(wanted.content):
                                chunk = os.read(child, min(65536, len(wanted.content)+1-len(content)))
                                if not chunk:
                                    break
                                content.extend(chunk)
                            if bytes(content) != wanted.content:
                                raise ValueError('candidate bytes mismatch')
                            files.append(SnapshotFile(path, wanted.git_mode, bytes(content)))
                        finally:
                            os.close(child)
                    else:
                        raise ValueError('extra, missing-prefix or nonregular candidate entry')
        walk(root_fd, '')
    finally:
        os.close(root_fd)
    actual = tuple(sorted(files, key=lambda file: file.path))
    if actual != expected_files:
        raise ValueError('incomplete candidate inventory')
    verify(actual, expected_manifest_hash, expected_tree)
    return actual


def require_readonly(root):
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        try:
            probe = os.open(PROBE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600,
                            dir_fd=descriptor)
        except OSError as error:
            if error.errno != errno.EROFS:
                raise ValueError('actual EROFS write denial required') from None
        else:
            os.close(probe)
            os.unlink(PROBE, dir_fd=descriptor)
            raise ValueError('candidate mount was writable')
    finally:
        os.close(descriptor)
    return 'EROFS'


def fixture_assertions(files):
    # This is one fixed provenance fixture, not application or arbitrary-code QA.
    expected = (SnapshotFile('data.bin', '100644', b'\x00\xffbinary'),
                SnapshotFile('index.html', '100644', b'<p>synthetic-artifact-ready</p>\n'),
                SnapshotFile('src/run.sh', '100755', b'#!/bin/sh\nexit 0\n'))
    if files != expected:
        raise ValueError('fixed provenance fixture assertions failed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest-hash', required=True)
    parser.add_argument('--source-tree', required=True)
    args = parser.parse_args()
    if not __debug__ or os.name != 'posix' or os.getuid() != 1001:
        raise SystemExit('isolated Linux UID1001 fixture required')
    raw = sys.stdin.buffer.read(MAX_FRAME+1)
    expected = decode_frame(raw, expected_manifest_hash=args.manifest_hash, expected_tree=args.source_tree)
    options = {'expected_files': expected, 'expected_manifest_hash': args.manifest_hash,
               'expected_tree': args.source_tree}
    before = read_candidate('/candidate', **options)
    denied = require_readonly('/candidate')
    fixture_assertions(before)
    after = read_candidate('/candidate', **options)
    print(json.dumps({'commandId': COMMAND_ID, 'helperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'beforeManifestHash': hashlib.sha256(snapshot_manifest(before).encode('ascii')).hexdigest(),
        'afterManifestHash': hashlib.sha256(snapshot_manifest(after).encode('ascii')).hexdigest(),
        'beforeTree': build_git_objects(before, expected_format='sha1').root_tree,
        'afterTree': build_git_objects(after, expected_format='sha1').root_tree,
        'readonlyDenial': denied, 'fixtureAssertions': True}), flush=True)
