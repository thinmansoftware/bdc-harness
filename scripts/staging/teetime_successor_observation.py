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


def observe_files(root, predecessor, run_id, query, *, history=1, retained=None, started=None):
    """query is the source-owned bounded Docker reader; tests inject fixtures.

    The controller must independently read the actual paused run and stored row.
    Return values alone are not evidence that those database checks occurred.
    """
    root = Path(root)
    started = int(time.time()*1000) if started is None else started
    if history not in (1,2,3,4):
        raise ValueError('closed historical attempt required')
    old = root/{1:'execution-harness/demo-execution.json',
                2:'successor-execution-harness/demo-execution.json',
                3:'diagnostic-execution-harness/demo-execution.json',
                4:'transport-repair-execution-harness/demo-execution.json'}[history]
    package_raw = frozen_file(old, predecessor['executionHash'])
    package = strict_json(package_raw)
    if (package.get('version') != history or package.get('kind') != 'supervised-demo-v'+str(history)
            or package.get('binding', {}).get('runId') != run_id
            or package['binding'].get('nodeId') != 'implement'
            or package['binding'].get('attempt') != history):
        raise ValueError('original first execution differs')
    control = root/{1:'control',2:'control-attempt-2',3:'control-attempt-3',4:'control-attempt-4'}[history]
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
    if history == 1 and (worker.get('authUnchanged') is not True or worker.get('normalProviderEnd') is not True
            or worker.get('providerIteratorClosed') is not True
            or worker.get('modelInvocations') != 1 or worker.get('workspaceUnchanged') is not False
            or any(worker.get(key) is not None for key in
                   ['artifactBase64','artifactHash','bindingHash','manifestHash','sourceTree'])):
        raise ValueError('closed failed workspace attempt required')
    if history == 2:
        from teetime_auth_artifact_protocol import empty_worker_result
        old_keys = set(empty_worker_result(demo=True)) - {'taskFailureDiagnostic'}
        if (set(worker) != old_keys or worker['modelInvocations'] is not None
                or worker['taskDiagnosticsPresent'] is not False or worker['passed'] is not False
                or worker['normalProviderEnd'] is not False or worker['providerIteratorClosed'] is not False
                or worker['authUnchanged'] is not True or worker['workspaceUnchanged'] is not True
                or worker['workspaceDiagnostic'] != {'category':'unchanged','entryCount':2,'maskEntryCount':0}
                or worker['preflightPassed'] is not True or worker['preflightChecks'] != 6
                or worker['taskStarted'] is not True or worker['oomKillDelta'] != 0
                or worker['assistantCount'] != 0 or worker['resultCount'] != 0
                or any(worker[key] is not None for key in
                       ['artifactBase64','artifactHash','bindingHash','manifestHash','sourceTree'])):
            raise ValueError('closed unknown-statistics second attempt required')
    if history in (3,4):
        from teetime_auth_artifact_protocol import empty_worker_result
        from teetime_artifact_contract import canonical
        elapsed = worker.get('elapsedMs')
        if type(elapsed) is not int or not 1 <= elapsed <= 630000:
            raise ValueError('bounded retained terminal attempt elapsed time required')
        expected = empty_worker_result(demo=True)
        expected.update(modelInvocations=1,authUnchanged=True,workspaceUnchanged=True,
            workspaceDiagnostic={'category':'unchanged','entryCount':2,'maskEntryCount':0},
            preflightPassed=True,preflightChecks=6,taskStarted=True,oomKillDelta=0,
            taskDiagnosticsPresent=True,providerIteratorClosed=True,elapsedMs=elapsed,failureCategory='rejected',
            taskFailureDiagnostic={'stage':'stream','exceptionCategory':
                'model_access_hint' if history == 3 else 'other','lastEvent':'none'})
        if canonical(worker) != canonical(expected):
            raise ValueError('closed retained terminal failure semantics required')
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
    if retained is not None:
        retained.extend([(old,package_raw),(control/'model.claim.json',claim_raw),
                         (control/'controller.lock',lock_raw),(control/'model-result.json',result_raw),
                         (receipt/'manifest.json',manifest_raw)])
    return {'resourcesAbsent': True, 'observedAt': started, 'expiresAt': started+30000,
            'manifestHash': 'sha256:'+hashlib.sha256(manifest_raw).hexdigest(),
            'lockHash': 'sha256:'+hashlib.sha256(lock_raw).hexdigest()}


def observe_two_histories(root, predecessors, run_id, query, execution):
    return _observe_histories(root, predecessors, run_id, query, execution, count=2)


def observe_three_histories(root, predecessors, run_id, query, execution):
    return _observe_histories(root, predecessors, run_id, query, execution, count=3)


def observe_minimal_histories(root, execution, query):
    """Separate diagnostic packet; never interpret it as product attempt5."""
    from teetime_minimal_execution import MinimalExecution
    if not isinstance(execution, MinimalExecution):
        raise ValueError('closed minimal execution required')
    return _observe_histories(root, execution.predecessors, execution.run_id, query, execution, count=4)


def _observe_histories(root, predecessors, run_id, query, execution, *, count):
    from teetime_demo_execution import parse_demo_execution
    if count not in (2,3,4) or len(predecessors) != count:
        raise ValueError('closed ordered histories required')
    if count != 4 and execution.binding['attempt'] != count+1:
        raise ValueError('closed ordered histories required')
    started = int(time.time()*1000)
    retained = []
    results = [observe_files(root, prior, run_id, query, history=index+1,
                             retained=retained, started=started)
               for index, prior in enumerate(predecessors)]
    packages = [parse_demo_execution(retained[index*5][1], prior['executionHash'][7:])
                for index, prior in enumerate(predecessors)]
    if dict(packages[1].predecessor) != dict(predecessors[0]):
        raise ValueError('retained predecessor chain differs')
    for index in range(2,count):
        if [dict(item) for item in packages[index].predecessors] != [dict(item) for item in predecessors[:index]]:
            raise ValueError('retained package chain differs')
    reference = packages[0] if count == 4 else execution
    if count == 4 and (reference.prepared_binding_hash != execution.prepared_binding_hash
            or reference.binding['runId'] != execution.run_id
            or reference.binding['authorityHash'] != execution.authority_hash):
        raise ValueError('diagnostic historical preparation or authority differs')
    for old in packages:
        if (old.prepared_binding_hash != reference.prepared_binding_hash
                or old.prepared != reference.prepared
                or any(old.binding[key] != reference.binding[key] for key in
                       ['runId','nodeId','authorityHash','policyHash','baseManifestHash'])):
            raise ValueError('historical preparation or authority differs')
    for path,raw in retained:
        if frozen_file(path) != raw:
            raise ValueError('historical bytes changed during combined observation')
    ended = int(time.time()*1000)
    if ended < started or ended-started > 20000:
        raise ValueError('combined historical observation deadline exceeded')
    return {'resourcesAbsent':True,'observedAt':started,'expiresAt':started+30000,
            'predecessors':[{'manifestHash':item['manifestHash'],'lockHash':item['lockHash']}
                            for item in results]}


def observe_local(root, predecessor, run_id, *, execution=None):
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
    if execution is not None:
        if execution.binding['attempt'] == 4:
            return observe_three_histories(root, predecessor, run_id, query, execution)
        return observe_two_histories(root, predecessor, run_id, query, execution)
    return observe_files(root, predecessor, run_id, query)
