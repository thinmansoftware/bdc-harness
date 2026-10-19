"""Diagnostic execution syntax only; matching bytes never grant account authority."""
from dataclasses import dataclass
import hashlib
import re
from types import MappingProxyType
from typing import Mapping
from teetime_artifact_contract import canonical
from teetime_demo_execution import predecessor_identity
from teetime_joined_fixture import exact, strict_json
from teetime_minimal_protocol import ALL_PATHS

MINIMAL_LIMITS = MappingProxyType({
    'querySeconds': 90, 'taskSeconds': 100, 'workerCaptureSeconds': 180,
    'watchdogSeconds': 300, 'containerSeconds': 330, 'proxyCaptureMaximumSeconds': 295,
    'readyRemainingSeconds': 265, 'authRemainingSeconds': 225,
    'protocolLineBytes': 32768, 'protocolTotalBytes': 65536,
    'taskResultBytes': 4096, 'workerResultBytes': 8192,
    'pcOuterSeconds': 450, 'sshTransportSeconds': 420,
    'observationDeliverySeconds': 15, 'reapSeconds': 10,
})


@dataclass(frozen=True)
class MinimalExecution:
    package_hash: str
    run_id: str
    prepared_binding_hash: str
    authority_hash: str
    run_policy_hash: str
    provider_policy_hash: str
    source: str
    base_source: str
    image: str
    operator_input_hash: str
    selected_hashes: Mapping
    predecessors: tuple


def _hex(value, size, prefix=''):
    return type(value) is str and re.fullmatch(re.escape(prefix)+'[a-f0-9]{'+str(size)+'}', value) is not None


def parse_minimal_execution(raw, expected_hash):
    if (type(raw) is not bytes or not 1 <= len(raw) <= 32768 or not raw.isascii()
            or not _hex(expected_hash, 64) or hashlib.sha256(raw).hexdigest() != expected_hash):
        raise ValueError('frozen bounded diagnostic packet required')
    value = strict_json(raw)
    keys = {'version', 'kind', 'repository', 'workflow', 'woId', 'runId', 'nodeId', 'attempt',
            'preparedBindingHash', 'authorityHash', 'runPolicyHash', 'providerPolicyHash',
            'provider', 'model', 'source', 'baseSource', 'image', 'operatorInputHash',
            'selectedHashes', 'predecessors', 'limits'}
    if type(value) is not dict or set(value) != keys or canonical(value).encode('ascii') != raw:
        raise ValueError('closed canonical diagnostic packet required')
    fixed = {'version': 1, 'kind': 'teetime-minimal-execution',
             'repository': 'thinmansoftware/whats-that-tee-time', 'workflow': 'bdc-teetime-supervised-walkthrough',
             'woId': 'WO-TEETIME-SIMULATED-WALKTHROUGH-01', 'nodeId': 'diagnose-transport', 'attempt': 1,
             'provider': 'codex-native-strict', 'model': 'gpt-5.6-sol', 'limits': dict(MINIMAL_LIMITS)}
    if not exact({key: value[key] for key in fixed}, fixed):
        raise ValueError('diagnostic fixed policy or limits differ')
    for key, size, prefix in [('runId', 32, ''), ('source', 40, ''), ('baseSource', 40, ''),
            ('image', 64, 'sha256:'), ('operatorInputHash', 64, ''),
            *[(name, 64, 'sha256:') for name in ['preparedBindingHash', 'authorityHash', 'runPolicyHash', 'providerPolicyHash']]]:
        if not _hex(value[key], size, prefix): raise ValueError('diagnostic identity format')
    hashes = value['selectedHashes']
    if (type(hashes) is not dict or set(hashes) != set(ALL_PATHS)
            or any(not _hex(item, 64) for item in hashes.values())
            or value['providerPolicyHash'] != 'sha256:'+hashes['packages/providers/src/codex/restricted-policy.ts']):
        raise ValueError('diagnostic selected helper or provider policy differs')
    history = value['predecessors']
    if type(history) is not list or len(history) != 4:
        raise ValueError('exact four historical implementation records required')
    predecessors = tuple(predecessor_identity(item) for item in history)
    if (len({item['attemptId'] for item in predecessors}) != 4 or len({item['owner'] for item in predecessors}) != 4
            or any(left['completedAt'] >= right['completedAt'] for left, right in zip(predecessors, predecessors[1:]))):
        raise ValueError('distinct ordered historical identities required')
    return MinimalExecution(expected_hash, value['runId'], value['preparedBindingHash'], value['authorityHash'],
        value['runPolicyHash'], value['providerPolicyHash'], value['source'], value['baseSource'], value['image'],
        value['operatorInputHash'], MappingProxyType(dict(hashes)), predecessors)


def minimal_admission_hash(execution, installed_manifest_hash):
    if type(execution) is not MinimalExecution or not _hex(installed_manifest_hash, 64):
        raise ValueError('closed diagnostic admission identities required')
    value = {'version': 1, 'kind': 'teetime-minimal-admission', 'executionHash': execution.package_hash,
             'installedManifestHash': installed_manifest_hash, 'operatorInputHash': execution.operator_input_hash,
             'source': execution.source}
    return hashlib.sha256(canonical(value).encode('ascii')).hexdigest()


def validate_minimal_carrier(raw, execution, installed_manifest_hash):
    digest = minimal_admission_hash(execution, installed_manifest_hash)
    if type(raw) is not bytes or not 1 <= len(raw) <= 8192 or not raw.isascii():
        raise ValueError('bounded actual reviewed carrier required')
    value = strict_json(raw)
    expected = {'version': 1, 'kind': 'teetime-minimal-admission-review',
        'executionHash': execution.package_hash, 'installedManifestHash': installed_manifest_hash,
        'operatorInputHash': execution.operator_input_hash, 'source': execution.source, 'admissionHash': digest}
    if not exact(value, expected) or canonical(value).encode('ascii') != raw:
        raise ValueError('actual reviewed diagnostic carrier differs')
    return MappingProxyType(dict(value))
