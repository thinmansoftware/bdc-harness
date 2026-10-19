"""Read-only predecessor files/resource reconciliation. Never grants execution."""
import hashlib
import os
from pathlib import Path
import re
import stat
import time

from teetime_bounded_process import capture
from teetime_joined_fixture import strict_json


def frozen_file(path, expected=None, limit=262144):
    path = Path(path)
    for parent in [path, *path.parents]:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('ordinary predecessor path required')
    if not stat.S_ISREG(path.lstat().st_mode) or path.stat().st_size > limit:
        raise ValueError('bounded predecessor file required')
    raw = path.read_bytes()
    if len(raw) > limit or (expected and 'sha256:'+hashlib.sha256(raw).hexdigest() != expected):
        raise ValueError('predecessor bytes differ')
    return raw


def observe_files(root, predecessor, run_id, query):
    """query is the source-owned bounded Docker reader; tests inject fixtures.

    The controller must independently read the actual paused run and stored row.
    Return values alone are not evidence that those database checks occurred.
    """
    root = Path(root)
    started = int(time.time()*1000)
    old = root/'execution-harness/demo-execution.json'
    package_raw = frozen_file(old, predecessor['executionHash'])
    package = strict_json(package_raw)
    if (package.get('version') != 1 or package.get('kind') != 'supervised-demo-v1'
            or package.get('binding', {}).get('runId') != run_id
            or package['binding'].get('nodeId') != 'implement'
            or package['binding'].get('attempt') != 1):
        raise ValueError('original first execution differs')
    control = root/'control'
    claim_raw = frozen_file(control/'model.claim.json', predecessor['claimHash'], 4096)
    claim = strict_json(claim_raw)
    if (set(claim) != {'version','phase','bindingHash','reviewId','reviewHead','reviewer','state'}
            or claim['version'] != 1 or claim['phase'] != 'model'
            or claim['bindingHash'] != predecessor['executionHash']
            or claim['reviewer'] != 'thinman-overseer[bot]' or claim['state'] != 'APPROVED'
            or type(claim['reviewId']) is not int or claim['reviewId'] <= 0
            or type(claim['reviewHead']) is not str or not re.fullmatch('[a-f0-9]{40}',claim['reviewHead'])):
        raise ValueError('original consumed claim differs')
    lock_raw = frozen_file(control/'controller.lock', predecessor['lockHash'], 4096)
    lock = strict_json(lock_raw)
    if (set(lock) != {'version','owner','pid','bindingHash'} or lock['version'] != 1
            or lock['bindingHash'] != predecessor['executionHash']
            or type(lock['owner']) is not str or not lock['owner']
            or type(lock['pid']) is not int or lock['pid'] <= 0):
        raise ValueError('original consumed lock differs')
    result_raw = frozen_file(control/'model-result.json', predecessor['resultHash'])
    result = strict_json(result_raw)
    owner = predecessor['owner']
    if (result.get('type') != 'RESULT' or result.get('task') != 'supervised-demo'
            or result.get('owner') != owner
            or result.get('artifactContractHash') != predecessor['executionHash'].removeprefix('sha256:')
            or result.get('cleanupErrors') != [] or type(result.get('result')) is not dict):
        raise ValueError('original terminal result differs')
    outcome = result['result']
    if (outcome.get('passed') is not False or outcome.get('cleanupVerified') is not True
            or outcome.get('proxyMetricsVerified') is not True
            or type(outcome.get('artifactResult')) is not dict):
        raise ValueError('terminal cleanup not verified')
    worker = outcome['artifactResult']
    if (worker.get('authUnchanged') is not True or worker.get('normalProviderEnd') is not True
            or worker.get('providerIteratorClosed') is not True
            or worker.get('modelInvocations') != 1 or worker.get('workspaceUnchanged') is not False
            or any(worker.get(key) is not None for key in
                   ['artifactBase64','artifactHash','bindingHash','manifestHash','sourceTree'])):
        raise ValueError('closed failed workspace attempt required')
    receipt = root.parent/owner
    manifest_raw = frozen_file(receipt/'manifest.json', predecessor['manifestHash'], 4096)
    manifest = strict_json(manifest_raw)
    if set(manifest) != {'owner','deadline','containers','networks'} or manifest['owner'] != owner:
        raise ValueError('original resource manifest differs')
    ids = []
    for key in ['containers','networks']:
        values = manifest[key]
        if (type(values) is not list or len(values) != 2 or any(type(value) is not str
                or not re.fullmatch('[a-f0-9]{64}',value) for value in values)):
            raise ValueError('closed original resource IDs required')
        ids += values
    if len(set(ids)) != 4:
        raise ValueError('duplicate original resource IDs')
    # Check exact IDs even if an existing object has had its owner label removed,
    # then check the owner label for any additional resources not in the receipt.
    for key, command in [('containers', ['ps','-a','--no-trunc','--format','{{.ID}}']),
                         ('networks', ['network','ls','--no-trunc','--format','{{.ID}}'])]:
        raw = query(command)
        if type(raw) is not bytes or len(raw) > 65536:
            raise ValueError('bounded Docker inventory required')
        found = raw.decode('ascii').splitlines()
        if any(not re.fullmatch('[a-f0-9]{64}',value) for value in found):
            raise ValueError('malformed actual Docker inventory')
        if set(found).intersection(manifest[key]):
            raise ValueError('predecessor resource still exists')
        owned = query([*command,'--filter','label=teetime.owner='+owner])
        if type(owned) is not bytes or owned.strip():
            raise ValueError('owned resources not absent')
    for path, raw in [(old,package_raw),(control/'model.claim.json',claim_raw),
                      (control/'controller.lock',lock_raw),(control/'model-result.json',result_raw),
                      (receipt/'manifest.json',manifest_raw)]:
        if frozen_file(path) != raw:
            raise ValueError('predecessor files changed during observation')
    ended = int(time.time()*1000)
    if ended < started or ended-started > 20000:
        raise ValueError('predecessor observation deadline exceeded')
    return {'resourcesAbsent': True, 'observedAt': started, 'expiresAt': started+30000,
            'manifestHash': 'sha256:'+hashlib.sha256(manifest_raw).hexdigest(),
            'lockHash': 'sha256:'+hashlib.sha256(lock_raw).hexdigest()}


def observe_local(root, predecessor, run_id):
    deadline = time.monotonic()+20
    root = Path(root)
    if os.name != 'nt' or root != Path.home()/'teetime-supervised-01':
        raise ValueError('fixed local Windows predecessor root required')
    docker = r'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
    # No account/config material is read. Docker uses the existing explicitly
    # owned empty configuration and the reviewed local Desktop named pipe.
    config = root/'execution-image-ad7682e21f8c-repair1/docker-config'
    for parent in [config,*config.parents]:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0) & 0x400:
            raise ValueError('ordinary Docker configuration path required')
    if not config.is_dir() or list(config.glob('config.json')):
        raise ValueError('owned empty Docker configuration required')
    env = {key:value for key,value in os.environ.items() if key.upper() in
           {'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'}}
    def query(command):
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise ValueError('predecessor query deadline exceeded')
        code, raw = capture([docker,'--host','npipe:////./pipe/dockerDesktopLinuxEngine',
                             '--config',str(config),*command], min(4,remaining), limit=65536, env=env)
        if code != 0:
            raise ValueError('actual Docker observation failed')
        return raw
    return observe_files(root, predecessor, run_id, query)
