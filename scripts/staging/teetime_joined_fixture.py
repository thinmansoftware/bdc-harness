"""Fixed synthetic SDK receipt validation; no credentials or runtime authority."""
import base64
import hashlib
import json
from pathlib import Path
import re

from teetime_artifact_contract import unique_object, reject_constant
from teetime_artifact_materialization import prepare_materialization
from teetime_fixture_diagnostics import DiagnosticProtocol
from teetime_snapshot import SnapshotFile, snapshot_manifest

SDK_HELPERS = tuple('scripts/staging/'+name for name in [
    'probe-teetime-artifact-fixture-worker.py', 'teetime-artifact-stream.ts',
    'teetime_artifact_contract.py', 'teetime_snapshot.py', 'teetime_git_objects.py',
    'teetime_fixture_diagnostics.py', 'teetime-sdk-lifecycle.ts'])+tuple(
    'packages/providers/src/codex/'+name for name in [
        'provider.ts', 'restricted-policy.ts', 'restricted-run-factory.ts'])+(
    'packages/providers/src/types.ts', 'packages/paths/src/logger.ts')


def joined_base():
    return (SnapshotFile('data.bin', '100644', b'\x00\xffbinary'),
            SnapshotFile('src/run.sh', '100755', b'#!/bin/sh\nexit 0\n'))


def joined_binding(owner, policy_hash):
    if (type(owner) is not str or re.fullmatch('teetime-fs-[a-f0-9]{12}', owner) is None
            or type(policy_hash) is not str or re.fullmatch('[a-f0-9]{64}', policy_hash) is None):
        raise ValueError('invalid fixed SDK binding')
    return {'runId': owner, 'nodeId': 'implement', 'attempt': 1,
        'authorityHash': 'sha256:'+'a'*64, 'policyHash': 'sha256:'+policy_hash,
        'baseManifestHash': hashlib.sha256(snapshot_manifest(joined_base()).encode('ascii')).hexdigest()}


def strict_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('invalid strict joined JSON') from None


def exact(actual, expected):
    if type(actual) is not type(expected):
        return False
    if type(expected) is dict:
        return set(actual) == set(expected) and all(exact(actual[key], value) for key, value in expected.items())
    if type(expected) is list:
        return len(actual) == len(expected) and all(exact(a, b) for a, b in zip(actual, expected))
    return actual == expected


def validate_sdk_output(exit_code, output, *, owner, image, source, base_source, helper_hashes):
    if type(exit_code) is not int or exit_code != 0:
        raise ValueError('SDK operator normal exit zero required')
    if type(output) is not bytes or len(output) > 16384 or not output.isascii():
        raise ValueError('joined SDK output bound')
    lines = output.splitlines(keepends=True)
    if len(lines) != 2 or any(not line.endswith(b'\n') for line in lines):
        raise ValueError('exact report and cleanup frames required')
    report, cleanup = (strict_json(line) for line in lines)
    expected_cleanup = {'receiptDirectory': str(Path.home()/owner), 'cleanupVerified': True}
    if not exact(cleanup, expected_cleanup) or type(report) is not dict:
        raise ValueError('SDK cleanup or report identity mismatch')
    expected = {'imageId': image, 'sourceSha': base_source,
        'probeSha256': helper_hashes[SDK_HELPERS[0]], 'pidsLimit': 128,
        'artifactSourceSha': source, 'artifactFileHashes': helper_hashes,
        'fixtureOwner': owner, 'joinedFixture': True}
    if set(report) != set(expected)|{'result'} or not exact({key: report[key] for key in expected}, expected):
        raise ValueError('SDK source, owner, image or helper mismatch')
    result = report['result']
    if type(result) is not dict or type(result.get('sdk')) is not dict:
        raise ValueError('SDK result required')
    sdk = result['sdk']
    protocol = DiagnosticProtocol()
    protocol.index = len(protocol.phases)
    protocol.check_final(sdk)
    expected_sdk = {'kind': 'result', 'accepted': True, 'bytesBase64': sdk['bytesBase64'],
        'intercepted': 1, 'threads': 1, 'optionsVerified': True, 'threadOptionsVerified': True,
        'importIntercepted': True, 'normalProviderEnd': True, 'providerIteratorClosed': True,
        'counts': {'assistant': 1, 'result': 1}, 'abortedBeforeCleanup': False,
        'phase': 'complete', 'errorName': None, 'errorCode': None}
    operations = result.get('operations')
    if type(operations) is not dict:
        raise ValueError('SDK request evidence required')
    upgrades = operations.get('websocketUpgradeAttempts')
    if type(upgrades) is not int or not 0 <= upgrades <= 32:
        raise ValueError('SDK upgrade attempt bound')
    expected_result = {'diagnosticPassed': True, 'case': 'success',
        'operations': {'requests': 1, 'websocketUpgradeAttempts': upgrades, 'errors': [], 'modelVerified': True},
        'sdk': expected_sdk, 'candidateVerified': True, 'syntheticAuthUnchanged': True,
        'credentialsUsed': False, 'realProviderRequests': 0, 'workspaceUnchanged': True,
        'deviations': ['loopback base URL', 'synthetic API credential', 'proxy variables removed'],
        'observableBoundary': 'provider chunks; normalizer does not expose raw events after first completion'}
    if not exact(result, expected_result):
        raise ValueError('SDK successful completion evidence mismatch')
    raw = base64.b64decode(sdk['bytesBase64'], validate=True)
    return prepare_materialization(raw, base_files=joined_base(), expected_binding=joined_binding(
        owner, helper_hashes['packages/providers/src/codex/restricted-policy.ts']),
        allowed_paths={'index.html': ('100644',)})
