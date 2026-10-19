"""Closed artifact selector contract. No login read, transport or materialization."""
import hashlib
from pathlib import Path
import re

from teetime_fixed_artifact import expected_artifact, validate_task_result
from teetime_joined_fixture import exact, strict_json

IMAGE_PATHS = tuple('scripts/staging/'+name for name in [
    'teetime_auth_receiver.py', 'teetime_canary_worker.py', 'teetime_auth_artifact_protocol.py',
    'teetime-fixed-artifact-task.ts', 'teetime-fixed-artifact.ts', 'teetime-artifact-stream.ts',
    'teetime-sdk-lifecycle.ts', 'teetime-canary-result.ts', 'teetime_fixed_artifact.py', 'teetime_artifact_contract.py',
    'teetime_joined_fixture.py', 'teetime_artifact_materialization.py',
    'teetime_fixture_diagnostics.py',
    'teetime_demo_execution.py', 'teetime_demo_case.py', 'teetime_demo_result.py',
    'teetime_artifact_workspace.py',
    'teetime-demo-task-entry.ts', 'teetime-demo-task.ts',
    'teetime_materialization_frame.py', 'teetime_snapshot.py', 'teetime_git_objects.py'])+tuple(
    'packages/providers/src/codex/'+name for name in ['provider.ts', 'restricted-policy.ts', 'restricted-run-factory.ts'])+(
    'packages/providers/src/types.ts', 'packages/paths/src/logger.ts')
ALL_PATHS = tuple(dict.fromkeys((*IMAGE_PATHS, *('scripts/staging/'+name for name in [
    'invoke-teetime-auth-canary.py', 'run-teetime-auth-canary.py', 'teetime_connect_proxy.py',
    'teetime_successor_observation.py',
    'teetime_watchdog.py', 'teetime_bounded_process.py', 'teetime_proxy_receipt.py',
    'teetime_canary_protocol.py', 'codex-probe-seccomp.json', 'moby-default-seccomp.json',
    'codex-probe-minimization.json']))))
POLICY_PATH = 'packages/providers/src/codex/restricted-policy.ts'
WORKER_BOOL = ('passed', 'preflightPassed', 'authUnchanged', 'workspaceUnchanged', 'artifactVerified',
    'servedModelVerified', 'taskDiagnosticsPresent', 'authenticationRejected', 'aborted',
    'normalProviderEnd', 'providerIteratorClosed', 'taskStarted')
IDENTITIES = ('artifactHash', 'bindingHash', 'manifestHash', 'sourceTree')


def validate_selector(task, source, nonce):
    if task not in ['filesystem', 'artifact', 'supervised-demo'] or type(task) is not str:
        raise ValueError('closed canary selector required')
    if type(nonce) is not str or re.fullmatch('[a-f0-9]{32}', nonce) is None:
        raise ValueError('fixed canary nonce required')
    if task == 'filesystem':
        if source is not None:
            raise ValueError('artifact source rejected in filesystem mode')
    elif type(source) is not str or re.fullmatch('[a-f0-9]{40}', source) is None:
        raise ValueError('exact artifact source required')


def artifact_identity(nonce, policy_hash):
    return hashlib.sha256(expected_artifact(nonce, policy_hash)).hexdigest()


def artifact_hashes(staging_root, source, base_source):
    validate_selector('artifact', source, '0'*32)
    if type(base_source) is not str or re.fullmatch('[a-f0-9]{40}', base_source) is None:
        raise ValueError('exact base source required')
    root = Path(staging_root).resolve().parents[1]
    raw = (root/'source-manifest.json').read_bytes()
    if len(raw) > 16384:
        raise ValueError('artifact archive manifest bound')
    manifest = strict_json(raw)
    if (type(manifest) is not dict or set(manifest) != {'source', 'baseSource', 'baseImage', 'fileHashes'}
            or manifest['source'] != source or manifest['baseSource'] != base_source
            or type(manifest['baseImage']) is not str or re.fullmatch('sha256:[a-f0-9]{64}', manifest['baseImage']) is None
            or type(manifest['fileHashes']) is not dict):
        raise ValueError('artifact archive identity mismatch')
    hashes = {}
    for path in ALL_PATHS:
        expected = manifest['fileHashes'].get(path)
        if type(expected) is not str or re.fullmatch('[a-f0-9]{64}', expected) is None:
            raise ValueError('artifact helper identity missing')
        if hashlib.sha256((root/path).read_bytes()).hexdigest() != expected:
            raise ValueError('artifact helper differs from frozen source')
        hashes[path] = expected
    return hashes


def validate_ready(value, *, nonce, image, base_source, source, hashes, execution=None):
    validate_selector('artifact', source, nonce)
    keys = {'type', 'nonce', 'image', 'sourceSha', 'owner', 'manifestSha256', 'workerId',
            'gatewayId', 'hashes', 'task', 'artifactSourceSha', 'artifactContractHash'}
    if type(value) is not dict or set(value) != keys:
        raise ValueError('artifact READY schema rejected')
    expected = {'type': 'READY', 'nonce': nonce, 'image': image, 'sourceSha': base_source,
        'hashes': hashes, 'task': 'artifact', 'artifactSourceSha': source,
        'artifactContractHash': artifact_identity(nonce, hashes[POLICY_PATH])}
    if execution is not None:
        validate_execution_context(execution, image, base_source, source, hashes[POLICY_PATH])
        expected.update({'task': 'supervised-demo', 'artifactContractHash': execution.package_hash})
    if not exact({key: value[key] for key in expected}, expected):
        raise ValueError('artifact READY binding rejected')
    for key, pattern in [('owner', 'teetime-auth-[a-f0-9]{12}'), ('manifestSha256', '[a-f0-9]{64}'),
                         ('workerId', '[a-f0-9]{64}'), ('gatewayId', '[a-f0-9]{64}')]:
        if type(value[key]) is not str or re.fullmatch(pattern, value[key]) is None:
            raise ValueError('artifact READY owned identity rejected')


def empty_worker_result(*, demo=False):
    value = {**dict.fromkeys(WORKER_BOOL, False), 'modelInvocations': 0, 'preflightChecks': 0,
        'assistantCount': 0, 'resultCount': 0, 'thinkingCount': 0, 'elapsedMs': 0,
        'oomKillDelta': None, 'failureCategory': 'not_started', 'artifactBase64': None,
        **dict.fromkeys(IDENTITIES, None)}
    if demo:
        value['workspaceDiagnostic'] = {'category':'inspection_failed','entryCount':0,'maskEntryCount':0}
        value['taskFailureDiagnostic'] = None
    return value


def validate_worker_result(value, *, nonce, policy_hash, execution=None):
    if type(value) is not dict or set(value) != set(empty_worker_result(demo=execution is not None)):
        raise ValueError('artifact worker schema rejected')
    if execution is not None:
        failure = value['taskFailureDiagnostic']
        if failure is not None:
            from teetime_demo_result import validate_failure_statistics
            validate_failure_statistics(value, failure)
            if value['passed'] or not value['taskDiagnosticsPresent'] or value['modelInvocations'] is None:
                raise ValueError('failed task diagnostic contradicts result')
        diagnostic = value['workspaceDiagnostic']
        from teetime_artifact_workspace import WORKSPACE_CATEGORIES
        if (type(diagnostic) is not dict or set(diagnostic) != {'category','entryCount','maskEntryCount'}
                or diagnostic['category'] not in WORKSPACE_CATEGORIES
                or any(type(diagnostic[key]) is not int or not 0 <= diagnostic[key] <= 17 for key in ['entryCount','maskEntryCount'])
                or value['workspaceUnchanged'] != (diagnostic == {'category':'unchanged','entryCount':2,'maskEntryCount':0})):
            raise ValueError('bounded workspace diagnostic rejected')
    if any(type(value[key]) is not bool for key in WORKER_BOOL) or value['servedModelVerified']:
        raise ValueError('artifact worker flags rejected')
    failed_demo = execution is not None and value['taskFailureDiagnostic'] is not None and not value['passed']
    for key, bound in [('preflightChecks', 6), ('assistantCount', 2 if failed_demo else 1),
                       ('resultCount', 2 if failed_demo else 1), ('thinkingCount', 65 if failed_demo else 64),
                       ('elapsedMs', 630000 if execution is not None else 120000)]:
        if type(value[key]) is not int or not 0 <= value[key] <= bound:
            raise ValueError('artifact worker counter rejected')
    invocations, oom = value['modelInvocations'], value['oomKillDelta']
    if invocations is not None and (type(invocations) is not int or not 0 <= invocations <= 1):
        raise ValueError('artifact query counter rejected')
    if oom is not None and (type(oom) is not int or not 0 <= oom <= 1024):
        raise ValueError('artifact OOM counter rejected')
    if value['failureCategory'] not in ['not_started', 'rejected', 'none']:
        raise ValueError('artifact failure diagnostic rejected')
    if value['preflightPassed'] and value['preflightChecks'] != 6:
        raise ValueError('incomplete artifact preflight')
    if not value['taskStarted'] and invocations != 0:
        raise ValueError('query before artifact task rejected')
    if value['taskStarted'] and not value['preflightPassed']:
        raise ValueError('artifact task before preflight rejected')
    if value['authenticationRejected'] and (value['preflightChecks'] != 5 or value['preflightPassed']
                                            or value['taskStarted'] or invocations != 0):
        raise ValueError('contradictory artifact auth rejection')
    if not value['passed']:
        if value['artifactBase64'] is not None or any(value[key] is not None for key in IDENTITIES):
            raise ValueError('rejected artifact bytes prohibited')
        if value['artifactVerified'] or value['failureCategory'] == 'none':
            raise ValueError('contradictory rejected artifact')
        return None
    required = ['preflightPassed', 'authUnchanged', 'workspaceUnchanged', 'artifactVerified',
                'taskDiagnosticsPresent', 'normalProviderEnd', 'providerIteratorClosed', 'taskStarted']
    if (not all(value[key] for key in required) or value['authenticationRejected'] or value['aborted']
            or oom != 0 or value['failureCategory'] != 'none'):
        raise ValueError('artifact wrapper success evidence rejected')
    packet = {key: value[key] for key in ['passed', 'artifactBase64', 'modelInvocations',
        'assistantCount', 'resultCount', 'thinkingCount', 'normalProviderEnd', 'providerIteratorClosed',
        'aborted', 'failureCategory', 'servedModelVerified']}
    import json
    if execution is None:
        packet['kind'] = 'fixed-artifact-v1'
        candidate = validate_task_result(0, json.dumps(packet).encode('ascii'), nonce=nonce, policy_hash=policy_hash)
    else:
        from teetime_demo_result import validate_demo_task_result
        validate_execution_context(execution, execution.image, execution.base_source, execution.source, policy_hash)
        del packet['passed']
        del packet['failureCategory']
        packet.update({'kind': 'supervised-demo-v1', 'collected': True})
        candidate = validate_demo_task_result(0, json.dumps(packet).encode('ascii'),
            prepared=execution.prepared, expected_binding=dict(execution.binding))
    expected = {'artifactHash': candidate.artifact_hash, 'bindingHash': candidate.binding_hash,
                'manifestHash': candidate.manifest_hash, 'sourceTree': candidate.source_tree}
    if not exact({key: value[key] for key in IDENTITIES}, expected):
        raise ValueError('artifact candidate identity mismatch')
    return candidate


def validate_report(report, exit_code, *, ready, policy_hash, execution=None):
    keys = {'type', 'nonce', 'owner', 'result', 'cleanupErrors', 'receiptDirectory', 'proxyMetrics',
            'task', 'artifactSourceSha', 'artifactContractHash'}
    if type(report) is not dict or set(report) != keys:
        raise ValueError('artifact RESULT schema rejected')
    expected = {key: ready[key] for key in ['nonce', 'owner', 'task', 'artifactSourceSha', 'artifactContractHash']}
    expected['type'] = 'RESULT'
    if not exact({key: report[key] for key in expected}, expected):
        raise ValueError('artifact RESULT binding rejected')
    outcome = report['result']
    if type(outcome) is not dict or set(outcome) != {'passed', 'cleanupVerified', 'credentialReceived', 'proxyMetricsVerified', 'artifactResult'}:
        raise ValueError('artifact controller result schema rejected')
    if any(type(outcome[key]) is not bool for key in ['passed', 'cleanupVerified', 'credentialReceived', 'proxyMetricsVerified']):
        raise ValueError('artifact controller flags rejected')
    if type(exit_code) is not int or exit_code != (0 if outcome['passed'] else 1):
        raise ValueError('artifact controller actual exit rejected')
    if (type(report['cleanupErrors']) is not list or len(report['cleanupErrors']) > 5
            or outcome['cleanupVerified'] and report['cleanupErrors'] != []):
        raise ValueError('artifact cleanup result contradictory')
    receipt = report['receiptDirectory']
    if (type(receipt) is not str or not 1 <= len(receipt) <= 512 or not receipt.isascii()
            or any(ord(char) < 32 or ord(char) == 127 for char in receipt)):
        raise ValueError('artifact receipt identity rejected')
    if outcome['proxyMetricsVerified']:
        metrics = report['proxyMetrics']
        if (type(metrics) is not dict or set(metrics) != {'bytes', 'header_or_destination_denied',
                'dns_denied', 'byte_limit', 'timeout', 'rejected_or_closed', 'closed'}
                or any(type(value) is not int or not 0 <= value <= 10**9 for value in metrics.values())):
            raise ValueError('artifact proxy metrics rejected')
    elif report['proxyMetrics'] is not None:
        raise ValueError('unverified artifact proxy metrics')
    worker = outcome['artifactResult']
    if outcome['passed'] and (not all(outcome[key] for key in ['cleanupVerified', 'credentialReceived', 'proxyMetricsVerified'])
            or report['cleanupErrors'] != [] or type(worker) is not dict or worker.get('passed') is not True):
        raise ValueError('artifact cleanup or compliance uncertain')
    if not outcome['passed'] and type(worker) is dict and worker.get('passed') is True:
        raise ValueError('uncertain controller cannot emit successful artifact')
    if execution is not None and (ready['task'] != 'supervised-demo' or ready['artifactContractHash'] != execution.package_hash):
        raise ValueError('demo report execution binding rejected')
    if execution is None and ready['task'] != 'artifact':
        raise ValueError('fixed report selector rejected')
    candidate = validate_worker_result(worker, nonce=ready['nonce'], policy_hash=policy_hash, execution=execution)
    return candidate if outcome['passed'] else None


def validate_execution_context(execution, image, base_source, source, policy_hash):
    from teetime_demo_execution import DemoExecution
    if (not isinstance(execution, DemoExecution) or execution.image != image
            or execution.source != source or execution.base_source != base_source
            or execution.binding['policyHash'] != 'sha256:' + policy_hash):
        raise ValueError('demo execution context differs')
