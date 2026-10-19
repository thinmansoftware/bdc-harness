"""Credential-free validation used by the single supervised Windows controller."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from teetime_auth_artifact_protocol import (artifact_hashes, validate_ready, validate_report,
                                          validate_execution_context, POLICY_PATH)
from teetime_demo_execution import parse_demo_execution, MAX_EXECUTION_BYTES
from teetime_joined_fixture import strict_json


def check(root, package_hash, mode, raw=b''):
    path = root / 'demo-execution.json'
    if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_EXECUTION_BYTES:
        raise ValueError('ordinary bounded execution package required')
    package = path.read_bytes()
    execution = parse_demo_execution(package, package_hash)
    hashes = artifact_hashes(root / 'scripts' / 'staging', execution.source, execution.base_source)
    validate_execution_context(execution, execution.image, execution.base_source,
                               execution.source, hashes[POLICY_PATH])
    if mode == 'predecessor':
        if execution.predecessors:
            from teetime_successor_observation import observe_local
            return observe_local(root.parent, execution.predecessors, execution.binding['runId'],execution=execution)
        if execution.predecessor is None:
            raise ValueError('successor predecessor required')
        from teetime_successor_observation import observe_local
        return observe_local(root.parent, dict(execution.predecessor), execution.binding['runId'])
    if mode == 'metadata':
        return {'packageHash': execution.package_hash,
                'preparedBindingHash': execution.prepared_binding_hash,
                'image': execution.image, 'source': execution.source, 'baseSource': execution.base_source,
                'binding': dict(execution.binding),
                'predecessor': dict(execution.predecessor) if execution.predecessor else None,
                'predecessors':[dict(entry) for entry in execution.predecessors]}
    if len(raw) > 196608:
        raise ValueError('bounded controller receipt required')
    value = strict_json(raw)
    ready = value if mode == 'ready' else value['ready']
    validate_ready(ready, nonce=ready['nonce'], image=execution.image,
                   base_source=execution.base_source, source=execution.source,
                   hashes=hashes, execution=execution)
    if mode == 'ready':
        return {'readyVerified': True}
    if mode != 'report' or set(value) != {'ready', 'report', 'exitCode'}:
        raise ValueError('closed report verification input required')
    candidate = validate_report(value['report'], value['exitCode'], ready=ready,
                                policy_hash=hashes[POLICY_PATH], execution=execution)
    outcome = value['report']['result']
    return {'passed': outcome['passed'], 'cleanupVerified': outcome['cleanupVerified'],
            'modelInvocations': outcome['artifactResult']['modelInvocations'],
            'artifactHash': outcome['artifactResult']['artifactHash'],
            'candidateVerified': candidate is not None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['metadata', 'ready', 'report', 'predecessor'])
    parser.add_argument('package_hash')
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(196609) if args.mode in ['ready','report'] else b''
        value = check(Path(__file__).resolve().parents[2], args.package_hash, args.mode, raw)
        sys.stdout.write(json.dumps(value, sort_keys=True, separators=(',', ':')))
    except Exception:
        raise SystemExit('supervised controller validation rejected') from None
