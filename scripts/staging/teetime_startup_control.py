"""Private diagnostic context and fixed identity checks; never grant admission."""
import os
from pathlib import Path
import re
import stat
import subprocess

CATALOG_HASH='e5a56e880294de40cfd546abc67943839247ef41f9fea095c6ffc93ca4f53e14'
BINARY_HASH='f9d4eab23d0e0726340e084ed22d668885c1dcabeb29ec508b8962e5e29b8dc6'


def startup_settings(owner):
    if re.fullmatch('teetime-startup-[0-9]+-[0-9]+',owner or '') is None:
        raise ValueError('startup owner rejected')
    return ['--label','teetime.startup-fixture='+owner,
            '--env','TEE_TIME_STARTUP_BINARY_HASH='+BINARY_HASH,
            '--pids-limit','128','--memory','768m','--memory-swap','768m','--cpus','1']


def verify_startup_identity(metadata):
    if metadata['binaryHash']!=BINARY_HASH or metadata['catalogHash']!=CATALOG_HASH:
        raise ValueError('startup binary or catalog identity mismatch')


def require_private_repository():
    # Host-only gh credential use. Nothing from this environment enters the CLI.
    result=subprocess.run(['gh','api','repos/thinmansoftware/bdc-xo','--jq','.private'],
                          capture_output=True,text=True,timeout=20)
    if result.returncode or result.stdout.strip()!='true':
        raise RuntimeError('startup private repository check failed')


def require_private_context(root,owner,environment=None):
    environment=os.environ if environment is None else environment
    if (environment.get('GITHUB_ACTIONS')!='true'
            or environment.get('GITHUB_REPOSITORY')!='thinmansoftware/bdc-xo'
            or environment.get('GITHUB_EVENT_NAME')!='workflow_dispatch'):
        raise ValueError('startup private dispatch context rejected')
    run=environment.get('GITHUB_RUN_ID','')
    attempt=environment.get('GITHUB_RUN_ATTEMPT','')
    if not run.isascii() or not run.isdigit() or not attempt.isascii() or not attempt.isdigit():
        raise ValueError('startup job identity rejected')
    if owner!='teetime-startup-'+run+'-'+attempt:
        raise ValueError('startup owner context mismatch')
    if os.name!='posix': raise RuntimeError('startup host requires POSIX')
    temporary=Path(environment.get('RUNNER_TEMP',''))
    root=Path(root)
    if (not temporary.is_absolute() or not root.is_absolute() or root.is_symlink()
            or root.absolute()!=root.resolve(strict=True)
            or root!=temporary.resolve(strict=True)/('teetime-private-'+run+'-'+attempt)):
        raise ValueError('startup trusted root context rejected')
    info=root.stat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o700 or info.st_uid!=os.getuid():
        raise ValueError('startup trusted root ownership rejected')
    require_private_repository()
