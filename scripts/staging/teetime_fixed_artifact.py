"""Pure fixed compliance result contract; wrapper observations remain independent."""
import base64
import hashlib
import json
import re

from teetime_artifact_contract import parse_artifact
from teetime_joined_fixture import exact, joined_base, strict_json
from teetime_snapshot import SnapshotFile, snapshot_manifest


def binding(nonce, policy_hash):
    if (type(nonce) is not str or re.fullmatch('[a-f0-9]{32}', nonce) is None
            or type(policy_hash) is not str or re.fullmatch('[a-f0-9]{64}', policy_hash) is None):
        raise ValueError('fixed compliance binding rejected')
    return {'runId': 'teetime-artifact-'+nonce, 'nodeId': 'implement', 'attempt': 1,
        'authorityHash': 'sha256:'+'a'*64, 'policyHash': 'sha256:'+policy_hash,
        'baseManifestHash': hashlib.sha256(snapshot_manifest(joined_base()).encode('ascii')).hexdigest()}


def expected_artifact(nonce, policy_hash):
    # Exact key order, escaping and no trailing newline are part of this fixture only.
    value = {'version': 1, 'binding': binding(nonce, policy_hash), 'operations': [
        {'action': 'write', 'path': 'index.html', 'baseHash': None, 'mode': '100644',
         'content': '<p>synthetic-artifact-ready</p>\n'}]}
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('ascii')


def validate_task_result(exit_code, output, *, nonce, policy_hash):
    expected = expected_artifact(nonce, policy_hash)
    if type(exit_code) is not int or exit_code != 0:
        raise ValueError('fixed task normal exit zero required')
    if type(output) is not bytes or len(output) > 4096 or not output.isascii():
        raise ValueError('fixed task bounded JSON required')
    result = strict_json(output)
    if type(result) is not dict:
        raise ValueError('fixed task object required')
    thinking = result.get('thinkingCount')
    encoded = result.get('artifactBase64')
    if type(thinking) is not int or not 0 <= thinking <= 64 or type(encoded) is not str or len(encoded) > 2048:
        raise ValueError('fixed task counts or artifact encoding rejected')
    packet = {'kind': 'fixed-artifact-v1', 'passed': True, 'artifactBase64': encoded,
        'modelInvocations': 1, 'assistantCount': 1, 'resultCount': 1, 'thinkingCount': thinking,
        'normalProviderEnd': True, 'providerIteratorClosed': True, 'aborted': False,
        'failureCategory': 'none', 'servedModelVerified': False}
    if not exact(result, packet):
        raise ValueError('fixed task completion rejected')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError('fixed artifact base64 rejected') from None
    if base64.b64encode(raw).decode('ascii') != encoded or raw != expected:
        raise ValueError('fixed artifact canonical bytes rejected')
    candidate = parse_artifact(raw, base_files=joined_base(), expected_binding=binding(nonce, policy_hash),
                               allowed_paths={'index.html': ('100644',)})
    expected_files = tuple(sorted((*joined_base(), SnapshotFile('index.html', '100644',
        b'<p>synthetic-artifact-ready</p>\n')), key=lambda item: item.path))
    if candidate.files != expected_files:
        raise ValueError('fixed artifact complete candidate mismatch')
    return candidate


def validate_wrapper_evidence(*, auth_before, auth_after, workspace_unchanged, preflight_checks):
    """Caller must derive these from actual wrapper observations, never task fields."""
    if (type(auth_before) is not bytes or type(auth_after) is not bytes
            or not 1 <= len(auth_before) <= 65536 or auth_before != auth_after
            or workspace_unchanged is not True or type(preflight_checks) is not int or preflight_checks != 6):
        raise ValueError('fixed artifact wrapper custody rejected')
