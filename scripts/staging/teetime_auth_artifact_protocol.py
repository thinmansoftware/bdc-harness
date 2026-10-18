"""Closed artifact selector contract. No login read, transport or materialization."""
import hashlib
from pathlib import Path
import re

from teetime_fixed_artifact import expected_artifact, validate_task_result
from teetime_joined_fixture import exact, strict_json

IMAGE_PATHS = tuple('scripts/staging/'+name for name in [
    'teetime_auth_receiver.py', 'teetime_canary_worker.py', 'teetime_auth_artifact_protocol.py',
    'teetime-fixed-artifact-task.ts', 'teetime-fixed-artifact.ts', 'teetime-artifact-stream.ts',
    'teetime-sdk-lifecycle.ts', 'teetime_fixed_artifact.py', 'teetime_artifact_contract.py',
    'teetime_joined_fixture.py', 'teetime_artifact_materialization.py',
    'teetime_fixture_diagnostics.py',
    'teetime_materialization_frame.py', 'teetime_snapshot.py', 'teetime_git_objects.py'])+tuple(
    'packages/providers/src/codex/'+name for name in ['provider.ts', 'restricted-policy.ts', 'restricted-run-factory.ts'])+(
    'packages/providers/src/types.ts', 'packages/paths/src/logger.ts')
ALL_PATHS = tuple(dict.fromkeys((*IMAGE_PATHS, *('scripts/staging/'+name for name in [
    'invoke-teetime-auth-canary.py', 'run-teetime-auth-canary.py', 'teetime_connect_proxy.py',
    'teetime_watchdog.py', 'teetime_bounded_process.py', 'teetime_proxy_receipt.py',
    'teetime_canary_protocol.py', 'codex-probe-seccomp.json', 'moby-default-seccomp.json',
    'codex-probe-minimization.json']))))
POLICY_PATH = 'packages/providers/src/codex/restricted-policy.ts'
WORKER_BOOL = ('passed', 'preflightPassed', 'authUnchanged', 'workspaceUnchanged', 'artifactVerified',
    'servedModelVerified', 'taskDiagnosticsPresent', 'authenticationRejected', 'aborted',
    'normalProviderEnd', 'providerIteratorClosed', 'taskStarted')
IDENTITIES = ('artifactHash', 'bindingHash', 'manifestHash', 'sourceTree')


def validate_selector(task, source, nonce):
    if task not in ['filesystem', 'artifact'] or type(task) is not str:
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


def validate_ready(value, *, nonce, image, base_source, source, hashes):
    validate_selector('artifact', source, nonce)
    keys = {'type', 'nonce', 'image', 'sourceSha', 'owner', 'manifestSha256', 'workerId',
            'gatewayId', 'hashes', 'task', 'artifactSourceSha', 'artifactContractHash'}
    if type(value) is not dict or set(value) != keys:
        raise ValueError('artifact READY schema rejected')
    expected = {'type': 'READY', 'nonce': nonce, 'image': image, 'sourceSha': base_source,
        'hashes': hashes, 'task': 'artifact', 'artifactSourceSha': source,
        'artifactContractHash': artifact_identity(nonce, hashes[POLICY_PATH])}
    if not exact({key: value[key] for key in expected}, expected):
        raise ValueError('artifact READY binding rejected')
    for key, pattern in [('owner', 'teetime-auth-[a-f0-9]{12}'), ('manifestSha256', '[a-f0-9]{64}'),
                         ('workerId', '[a-f0-9]{64}'), ('gatewayId', '[a-f0-9]{64}')]:
        if type(value[key]) is not str or re.fullmatch(pattern, value[key]) is None:
            raise ValueError('artifact READY owned identity rejected')


def empty_worker_result():
    return {**dict.fromkeys(WORKER_BOOL, False), 'modelInvocations': 0, 'preflightChecks': 0,
        'assistantCount': 0, 'resultCount': 0, 'thinkingCount': 0, 'elapsedMs': 0,
        'oomKillDelta': None, 'failureCategory': 'not_started', 'artifactBase64': None,
        **dict.fromkeys(IDENTITIES, None)}


def validate_worker_result(value, *, nonce, policy_hash):
    if type(value) is not dict or set(value) != set(empty_worker_result()):
        raise ValueError('artifact worker schema rejected')
    if any(type(value[key]) is not bool for key in WORKER_BOOL) or value['servedModelVerified']:
        raise ValueError('artifact worker flags rejected')
    for key, bound in [('preflightChecks', 6), ('assistantCount', 1), ('resultCount', 1),
                       ('thinkingCount', 64), ('elapsedMs', 120000)]:
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
    packet['kind'] = 'fixed-artifact-v1'
    import json
    candidate = validate_task_result(0, json.dumps(packet).encode('ascii'), nonce=nonce, policy_hash=policy_hash)
    expected = {'artifactHash': candidate.artifact_hash, 'bindingHash': candidate.binding_hash,
                'manifestHash': candidate.manifest_hash, 'sourceTree': candidate.source_tree}
    if not exact({key: value[key] for key in IDENTITIES}, expected):
        raise ValueError('artifact candidate identity mismatch')
    return candidate


def validate_report(report, exit_code, *, ready, policy_hash):
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
    candidate = validate_worker_result(worker, nonce=ready['nonce'], policy_hash=policy_hash)
    return candidate if outcome['passed'] else None
