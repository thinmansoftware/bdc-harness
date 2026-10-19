"""One credential-free Windows dependency install; never starts the controller."""
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import subprocess
import tarfile
import time

HOME = Path(r'C:\Users\claude.LAPTOP-BQ6IEJNC')
ROOT = HOME / 'teetime-supervised-01'
INPUT = HOME / 'teetime-controller-input-93b6'
BUN = HOME / '.bun/bin/bun.exe'
SOURCE = '93b6bb611fb424aac3b756993f0c1a8dc702f7ca'
ARCHIVE_HASH = '695b3c49b38bc1d1b92fffdbd0d00c58846498cec0eb7d5af3d8169c212db1f3'
MANIFEST_HASH = '13cd53880ca4180158711640a6dde69c6ab727864a758fae595c1555820588ce'
BUN_HASH = '8dc0cd4351f596df6bb71c03575168078bb0f9872ef4d5ff1b8579dd9507cf70'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inside(path, parent):
    return path.resolve().is_relative_to(parent.resolve())


def ordinary_chain(path):
    for entry in [path, *path.parents]:
        info = entry.lstat()
        if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError('Reparse path rejected')


def main():
    if os.name != 'nt' or os.path.lexists(ROOT):
        raise ValueError('New Windows staging root required')
    for path in (HOME, INPUT, BUN):
        ordinary_chain(path)
    for path, expected in [(BUN, BUN_HASH), (INPUT / 'harness-source.tar', ARCHIVE_HASH),
                           (INPUT / 'harness-source-manifest.json', MANIFEST_HASH)]:
        if not path.is_file() or path.is_symlink() or digest(path) != expected:
            raise ValueError('Frozen input differs')
    manifest = json.loads((INPUT / 'harness-source-manifest.json').read_text())
    if manifest['source'] != SOURCE or manifest['version'] != 1 or len(manifest['files']) != 2082:
        raise ValueError('Source manifest differs')
    # Validate the entire archive before creating the owned staging root.
    with tarfile.open(INPUT / 'harness-source.tar') as archive:
        names = []
        folded = set()
        for member in archive.getmembers():
            parts = member.name.split('/')
            windows_path = PureWindowsPath(member.name)
            if (windows_path.is_absolute() or windows_path.drive or '\\' in member.name
                    or ':' in member.name or not re.fullmatch(r'[A-Za-z0-9_./-]+', member.name)
                    or any(p in ('', '.', '..', '.git', 'node_modules') for p in parts)
                    or member.name.casefold() in folded):
                raise ValueError('Unsafe archive path')
            folded.add(member.name.casefold())
            if member.isdir():
                continue
            if not member.isfile() or member.name not in manifest['files']:
                raise ValueError('Unexpected archive member')
            data = archive.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != manifest['files'][member.name]:
                raise ValueError('Archive bytes differ')
            names.append(member.name)
        if sorted(names) != sorted(manifest['files']):
            raise ValueError('Incomplete or duplicate archive')
        # No project-level install configuration or dotenv may affect acquisition.
        forbidden = [n for n in names if Path(n).name in ('.npmrc', '.env', '.env.local')]
        if forbidden:
            raise ValueError('Unreviewed install configuration')
        ROOT.mkdir()
        source = ROOT / 'harness'
        source.mkdir()
        for member in archive.getmembers():
            if member.isfile():
                target = source / member.name
                if not inside(target, source):
                    raise ValueError('Destination escapes source')
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    stream.write(archive.extractfile(member).read())
    (ROOT / 'harness-source-manifest.json').write_bytes((INPUT / 'harness-source-manifest.json').read_bytes())
    private = ROOT / 'dependency-acquisition'
    private.mkdir()
    for name in ('home', 'appdata', 'localappdata', 'cache', 'temp'):
        (private / name).mkdir()
    env = {'SystemRoot': r'C:\Windows', 'WINDIR': r'C:\Windows',
           'COMSPEC': r'C:\Windows\System32\cmd.exe',
           'PATH': r'C:\Windows\System32',
           'HOME': str(private / 'home'), 'USERPROFILE': str(private / 'home'),
           'APPDATA': str(private / 'appdata'), 'LOCALAPPDATA': str(private / 'localappdata'),
           'TEMP': str(private / 'temp'), 'TMP': str(private / 'temp'),
           'BUN_INSTALL_CACHE_DIR': str(private / 'cache'), 'CI': '1',
           'DO_NOT_TRACK': '1', 'NPM_CONFIG_USERCONFIG': str(private / 'home/.npmrc')}
    (private / 'home/.npmrc').write_bytes(b'')
    command = [str(BUN), '--no-env-file', 'install', '--frozen-lockfile',
               '--ignore-scripts', '--linker=hoisted', '--no-progress']
    stdout, stderr = private / 'stdout.log', private / 'stderr.log'
    reason = None
    with stdout.open('xb') as out, stderr.open('xb') as err:
        process = subprocess.Popen(command, cwd=source, env=env, stdin=subprocess.DEVNULL,
                                   stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
        deadline = time.monotonic() + 600
        try:
            while process.poll() is None:
                if time.monotonic() > deadline or stdout.stat().st_size + stderr.stat().st_size > 2 * 1024 * 1024:
                    reason = 'deadline-or-output-bound'
                    break
                time.sleep(0.2)
        except BaseException:
            reason = 'interrupted-or-observation-failed'
            raise
        finally:
            cleanup = 'already-exited'
            if process.poll() is None:
                cleanup = 'termination-unverified'
                try:
                    killed = subprocess.run([r'C:\Windows\System32\taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                    process.wait(timeout=30)
                    if killed.returncode == 0:
                        cleanup = 'tree-terminated-and-parent-reaped'
                except BaseException:
                    pass
            (private / 'process-receipt.json').write_text(json.dumps({
                'exitCode': process.poll(), 'reaped': process.poll() is not None,
                'cleanup': cleanup, 'failure': reason}), encoding='ascii')
            if cleanup == 'termination-unverified':
                raise ValueError('Process termination unverified; operator reconciliation required')
    if process.returncode != 0 or reason or stdout.stat().st_size + stderr.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('Installation failed; owned files retained, no retry')
    if digest(BUN) != BUN_HASH:
        raise ValueError('Bun executable changed')
    actual = {}
    inventory = {}
    stack = [source]
    seen = set()
    entries = total_bytes = 0
    while stack:
        folder = stack.pop()
        canonical = str(folder.resolve()).casefold()
        if canonical in seen:
            raise ValueError('Directory cycle')
        seen.add(canonical)
        for path in folder.iterdir():
            entries += 1
            if entries > 200000:
                raise ValueError('Dependency entry bound')
            if not inside(path, source):
                raise ValueError('Dependency escapes frozen source')
            key = path.relative_to(source).as_posix()
            dependency = 'node_modules' in path.relative_to(source).parts
            info = path.lstat()
            if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                if not dependency or not path.exists() or path.resolve() in [folder, *folder.parents]:
                    raise ValueError('Invalid dependency link')
                inventory[key] = {'target': str(path.resolve().relative_to(source.resolve()))}
                # Record links, never recurse through junctions or symlinks.
            elif path.is_dir():
                stack.append(path)
            elif path.is_file():
                total_bytes += info.st_size
                if total_bytes > 2 * 1024 * 1024 * 1024:
                    raise ValueError('Dependency byte bound')
                if dependency:
                    inventory[key] = {'sha256': digest(path), 'bytes': info.st_size}
                else:
                    actual[key] = digest(path)
            else:
                raise ValueError('Special dependency file rejected')
    if actual != manifest['files']:
        raise ValueError('Source changed during install')
    for name in ('core', 'paths', 'workflows', 'providers', 'git', 'isolation'):
        if (source / 'node_modules/@archon' / name).resolve() != (source / 'packages' / name).resolve():
            raise ValueError('Workspace dependency differs')
    (private / 'dependency-inventory.json').write_text(json.dumps(inventory, sort_keys=True), encoding='ascii')
    receipt = {'source': SOURCE, 'bunSha256': BUN_HASH, 'exitCode': process.returncode,
               'sourceFilesVerified': len(actual), 'dependencyEntries': len(inventory),
               'inventorySha256': digest(private / 'dependency-inventory.json'),
               'accountProvided': False, 'modelAttempts': 0, 'controllerStarted': False}
    (private / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='ascii')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
