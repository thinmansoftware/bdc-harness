"""Closed demo execution input. A matching hash is not an execution approval.

The trusted launcher must verify independent review, consume its phase claim and
persist the provider attempt before credentials or this packet reach a worker.
"""
import hashlib
import re
from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Mapping

from teetime_artifact_contract import canonical, validate_binding
from teetime_demo_case import ASSET_PATHS, prepare_demo_base
from teetime_joined_fixture import exact, strict_json
from teetime_materialization_frame import decode_frame

MAX_EXECUTION_BYTES = 262144
DEMO_LIMITS = {
    'querySeconds': 600, 'workerSeconds': 630, 'controllerSeconds': 720,
    'watchdogSeconds': 780, 'containerSeconds': 810,
    'protocolLineBytes': 98304, 'protocolTotalBytes': 196608,
    'taskInputBytes': 160000, 'taskResultBytes': 90112,
}


@dataclass(frozen=True)
class DemoExecution:
    package_hash: str
    prepared_binding_hash: str
    image: str
    source: str
    base_source: str
    binding: Mapping
    prepared: object
    prompt: str
    prompt_hash: str
    predecessor: Mapping | None = None
    predecessors: tuple = ()


def predecessor_identity(prior):
    if (type(prior) is not dict or set(prior) != {'attemptId', 'completedAt', 'rowHash',
            'executionHash', 'resultHash', 'claimHash', 'owner', 'manifestHash', 'lockHash'}
            or type(prior['attemptId']) is not str
            or re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', prior['attemptId']) is None
            or type(prior['completedAt']) is not str
            or re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', prior['completedAt']) is None
            or type(prior['owner']) is not str
            or re.fullmatch('teetime-auth-[a-f0-9]{12}', prior['owner']) is None
            or any(type(prior[key]) is not str or re.fullmatch('sha256:[a-f0-9]{64}', prior[key]) is None
                   for key in ('rowHash', 'executionHash', 'resultHash', 'claimHash', 'manifestHash', 'lockHash'))):
        raise ValueError('closed successor predecessor binding required')
    datetime.strptime(prior['completedAt'], '%Y-%m-%dT%H:%M:%S.%fZ')
    return MappingProxyType(dict(prior))


def parse_demo_execution(raw, expected_hash):
    if (type(raw) is not bytes or not 1 <= len(raw) <= MAX_EXECUTION_BYTES
            or not raw.isascii() or type(expected_hash) is not str
            or re.fullmatch('[a-f0-9]{64}', expected_hash) is None
            or hashlib.sha256(raw).hexdigest() != expected_hash):
        raise ValueError('frozen demo execution bytes required')
    value = strict_json(raw)
    keys = {'version', 'kind', 'preparedBindingHash', 'image', 'source', 'baseSource',
            'binding', 'preparedFrame', 'originalTree', 'originalManifestHash',
            'assetHashes', 'prompt', 'promptHash', 'limits'}
    successor = type(value) is dict and value.get('version') == 2
    diagnostic_successor = type(value) is dict and value.get('version') == 3
    if successor:
        keys.add('predecessor')
    if diagnostic_successor:
        keys.add('predecessors')
    if type(value) is not dict or set(value) != keys or canonical(value).encode('ascii') != raw:
        raise ValueError('closed canonical demo execution package required')
    if (type(value['version']) is not int or value['version'] not in (1, 2, 3)
            or value['kind'] != ('supervised-demo-v3' if diagnostic_successor else 'supervised-demo-v2' if successor else 'supervised-demo-v1')):
        raise ValueError('demo package version rejected')
    for key, pattern in [('preparedBindingHash', 'sha256:[a-f0-9]{64}'),
                         ('image', 'sha256:[a-f0-9]{64}'), ('source', '[a-f0-9]{40}'),
                         ('baseSource', '[a-f0-9]{40}'), ('originalTree', '[a-f0-9]{40}'),
                         ('originalManifestHash', '[a-f0-9]{64}'), ('promptHash', '[a-f0-9]{64}')]:
        if type(value[key]) is not str or re.fullmatch(pattern, value[key]) is None:
            raise ValueError('demo package identity rejected')
    if not exact(value['limits'], DEMO_LIMITS):
        raise ValueError('demo execution limits differ')
    binding = value['binding']
    validate_binding(binding)
    if binding['nodeId'] != 'implement' or binding['attempt'] != (3 if diagnostic_successor else 2 if successor else 1):
        raise ValueError('closed supervised implementation attempt required')
    predecessor = predecessor_identity(value['predecessor']) if successor else None
    predecessors = ()
    if diagnostic_successor:
        entries = value['predecessors']
        if type(entries) is not list or len(entries) != 2:
            raise ValueError('exactly two ordered predecessors required')
        predecessors = tuple(predecessor_identity(entry) for entry in entries)
        if (len({entry['attemptId'] for entry in predecessors}) != 2
                or len({entry['owner'] for entry in predecessors}) != 2
                or predecessors[0]['completedAt'] >= predecessors[1]['completedAt']):
            raise ValueError('distinct chronological predecessors required')
    frame = value['preparedFrame']
    if type(frame) is not dict or set(frame) != {'version', 'manifestHash', 'sourceTree', 'files'}:
        raise ValueError('complete prepared frame required')
    files = decode_frame(canonical(frame).encode('ascii'),
                         expected_manifest_hash=binding['baseManifestHash'], expected_tree=frame['sourceTree'])
    original = tuple(file for file in files if file.path == 'README.md')
    assets = {file.path: file.content for file in files if file.path in ASSET_PATHS}
    if len(files) != 10:
        raise ValueError('closed prepared inventory required')
    prepared = prepare_demo_base(original_files=original,
        expected_original_tree=value['originalTree'], expected_original_manifest=value['originalManifestHash'],
        assets=assets, expected_asset_hashes=value['assetHashes'])
    if prepared.files != files or prepared.manifest_hash != binding['baseManifestHash']:
        raise ValueError('prepared demo identity differs')
    prompt = value['prompt']
    if (type(prompt) is not str or not 1 <= len(prompt) <= 131072 or not prompt.isascii()
            or '\0' in prompt or hashlib.sha256(prompt.encode('ascii')).hexdigest() != value['promptHash']):
        raise ValueError('frozen complete prompt required')
    execution = DemoExecution(expected_hash, value['preparedBindingHash'], value['image'],
        value['source'], value['baseSource'], MappingProxyType(dict(binding)), prepared, prompt, value['promptHash'], predecessor, predecessors)
    task_input(execution)  # Check escaped wire size before any authenticated work.
    return execution


def task_input(execution):
    raw = canonical({'runId': execution.binding['runId'],
        'policyHash': execution.binding['policyHash'].removeprefix('sha256:'),
        'prompt': execution.prompt, 'promptHash': execution.prompt_hash}).encode('ascii')
    if len(raw) > DEMO_LIMITS['taskInputBytes']:
        raise ValueError('demo task input overflow')
    return raw
