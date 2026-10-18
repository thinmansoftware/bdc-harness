"""Pure source-data contract candidate. Model workspace files are never read.

Expected authority, base bytes and path capabilities come from the trusted
controller. This parser cannot authenticate its caller or grant publication.
The separate SDK stream contract is not qualified by this pure helper.
"""
from dataclasses import dataclass
import hashlib
import json
import re

from teetime_git_objects import build_git_objects
from teetime_snapshot import MAX_FILE, MAX_FILES, SnapshotFile, snapshot_manifest, valid_path

MAX_ARTIFACT_BYTES = 65536
MAX_DEPTH = 8
MAX_OPERATIONS = 32
BINDING_KEYS = frozenset(('runId', 'nodeId', 'attempt', 'authorityHash',
                          'policyHash', 'baseManifestHash'))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def exact_object(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError('artifact schema fields mismatch')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate artifact JSON key')
        result[key] = value
    return result


def reject_constant(_):
    raise ValueError('nonfinite JSON value')


def validate_depth(text):
    depth = 0
    quoted = escaped = False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in '[{':
            depth += 1
            if depth > MAX_DEPTH:
                raise ValueError('artifact nesting bound')
        elif char in ']}':
            depth -= 1
            if depth < 0:
                raise ValueError('invalid artifact nesting')
    if depth or quoted:
        raise ValueError('incomplete artifact JSON')


def validate_binding(value):
    exact_object(value, BINDING_KEYS)
    for key in ['runId', 'nodeId']:
        if type(value[key]) is not str or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}', value[key]):
            raise ValueError('invalid artifact run identity')
    if type(value['attempt']) is not int or not 1 <= value['attempt'] <= 1000000:
        raise ValueError('invalid artifact attempt')
    for key in ['authorityHash', 'policyHash', 'baseManifestHash']:
        pattern = 'sha256:[a-f0-9]{64}' if key != 'baseManifestHash' else '[a-f0-9]{64}'
        if type(value[key]) is not str or not re.fullmatch(pattern, value[key]):
            raise ValueError('invalid artifact authority identity')


@dataclass(frozen=True)
class ArtifactCandidate:
    files: tuple[SnapshotFile, ...]
    manifest: str
    manifest_hash: str
    source_tree: str
    artifact_hash: str
    binding_hash: str


def parse_artifact(raw, *, base_files, expected_binding, allowed_paths):
    """Validate explicit operations against a complete trusted base and capabilities."""
    if type(raw) is not bytes or not 2 <= len(raw) <= MAX_ARTIFACT_BYTES or raw.startswith(b'\xef\xbb\xbf'):
        raise ValueError('artifact byte bound or encoding')
    try:
        text = raw.decode('utf-8', errors='strict')
    except UnicodeError:
        raise ValueError('artifact UTF-8 required') from None
    validate_depth(text)
    try:
        value = json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, RecursionError):
        raise ValueError('invalid strict artifact JSON') from None
    exact_object(value, ('version', 'binding', 'operations'))
    if type(value['version']) is not int or value['version'] != 1:
        raise ValueError('unsupported artifact version')
    validate_binding(expected_binding)
    validate_binding(value['binding'])
    if value['binding'] != expected_binding:
        raise ValueError('foreign or stale artifact binding')
    # Structural checks do not establish base provenance; controller custody does.
    build_git_objects(base_files, expected_format='sha1')
    base_manifest = snapshot_manifest(base_files)
    if sha256(base_manifest.encode('ascii')) != expected_binding['baseManifestHash']:
        raise ValueError('trusted base manifest identity mismatch')
    if type(allowed_paths) is not dict or not 1 <= len(allowed_paths) <= MAX_FILES:
        raise ValueError('bounded explicit path capabilities required')
    allowed = {}
    folded = set()
    for path, modes in allowed_paths.items():
        valid_path(path)
        if path.casefold() in folded:
            raise ValueError('case-colliding path capabilities')
        folded.add(path.casefold())
        if (type(modes) is not tuple or not 1 <= len(modes) <= 2
                or any(type(mode) is not str or mode not in ['100644', '100755'] for mode in modes)
                or len(set(modes)) != len(modes)):
            raise ValueError('invalid permitted file modes')
        allowed[path] = frozenset(modes)
    ops = value['operations']
    if type(ops) is not list or not 1 <= len(ops) <= MAX_OPERATIONS:
        raise ValueError('artifact operation count bound')
    base = {file.path: file for file in base_files}
    candidate = dict(base)
    changed_paths = set()
    for op in ops:
        if type(op) is not dict or op.get('action') not in ['write', 'delete']:
            raise ValueError('invalid artifact operation')
        action = op['action']
        fields = ('action', 'path', 'baseHash', 'mode', 'content') if action == 'write' else ('action', 'path', 'baseHash')
        exact_object(op, fields)
        path = valid_path(op['path'])
        if path not in allowed or path.casefold() in changed_paths:
            raise ValueError('operation outside scope or duplicate path')
        changed_paths.add(path.casefold())
        existing = base.get(path)
        old_hash = sha256(existing.content) if existing else None
        if op['baseHash'] != old_hash or (op['baseHash'] is not None and type(op['baseHash']) is not str):
            raise ValueError('per-path base identity mismatch')
        if action == 'delete':
            if existing is None:
                raise ValueError('cannot delete absent base path')
            del candidate[path]
        else:
            if type(op['mode']) is not str or op['mode'] not in allowed[path] or type(op['content']) is not str:
                raise ValueError('operation mode or content mismatch')
            try:
                content = op['content'].encode('ascii', errors='strict')
            except UnicodeError:
                raise ValueError('artifact source content must be ASCII') from None
            if len(content) > MAX_FILE or b'\0' in content:
                raise ValueError('artifact file bound or NUL content')
            candidate[path] = SnapshotFile(path, op['mode'], content)
    files = tuple(candidate[path] for path in sorted(candidate))
    if files == tuple(sorted(base_files, key=lambda file: file.path)):
        raise ValueError('artifact makes no effective source change')
    tree = build_git_objects(files, expected_format='sha1')
    manifest = snapshot_manifest(files)
    return ArtifactCandidate(files, manifest, sha256(manifest.encode('ascii')),
        tree.root_tree, sha256(raw), sha256(canonical(expected_binding).encode('ascii')))
