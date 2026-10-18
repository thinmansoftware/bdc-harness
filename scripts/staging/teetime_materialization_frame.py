"""Pure bounded transport for a complete candidate; identities come from controller."""
import base64
import binascii
import hashlib
import json
import re

from teetime_artifact_contract import unique_object, reject_constant, validate_depth
from teetime_git_objects import build_git_objects
from teetime_snapshot import MAX_FILE, MAX_FILES, SnapshotFile, snapshot_manifest

MAX_FRAME = 12*1024*1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def verify(files, expected_manifest_hash, expected_tree):
    for value, size in [(expected_manifest_hash, 64), (expected_tree, 40)]:
        if type(value) is not str or re.fullmatch('[a-f0-9]{'+str(size)+'}', value) is None:
            raise ValueError('invalid controller identity')
    tree = build_git_objects(files, expected_format='sha1').root_tree
    digest = hashlib.sha256(snapshot_manifest(files).encode('ascii')).hexdigest()
    if tree != expected_tree or digest != expected_manifest_hash:
        raise ValueError('complete candidate identity mismatch')


def encode_frame(files, *, expected_manifest_hash, expected_tree):
    verify(files, expected_manifest_hash, expected_tree)
    value = {'version': 1, 'manifestHash': expected_manifest_hash, 'sourceTree': expected_tree,
             'files': [{'path': file.path, 'mode': file.git_mode,
                        'contentBase64': base64.b64encode(file.content).decode('ascii')}
                       for file in sorted(files, key=lambda file: file.path)]}
    raw = canonical(value)
    if len(raw) > MAX_FRAME:
        raise ValueError('materialization frame bound')
    return raw


def decode_frame(raw, *, expected_manifest_hash, expected_tree):
    if type(raw) is not bytes or not 2 <= len(raw) <= MAX_FRAME or not raw.isascii():
        raise ValueError('bounded ASCII frame required')
    try:
        text = raw.decode('ascii')
        validate_depth(text)
        value = json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, RecursionError):
        raise ValueError('invalid strict frame JSON') from None
    if type(value) is not dict or set(value) != {'version', 'manifestHash', 'sourceTree', 'files'}:
        raise ValueError('invalid frame fields')
    if type(value['version']) is not int or value['version'] != 1 or canonical(value) != raw:
        raise ValueError('noncanonical or unsupported frame')
    if value['manifestHash'] != expected_manifest_hash or value['sourceTree'] != expected_tree:
        raise ValueError('foreign frame identity')
    records = value['files']
    if type(records) is not list or len(records) > MAX_FILES:
        raise ValueError('frame file count bound')
    files = []
    for record in records:
        if type(record) is not dict or set(record) != {'path', 'mode', 'contentBase64'}:
            raise ValueError('invalid frame file fields')
        encoded = record['contentBase64']
        if type(encoded) is not str or len(encoded) > 4*((MAX_FILE+2)//3):
            raise ValueError('encoded file bound')
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError('invalid file base64') from None
        if base64.b64encode(content).decode('ascii') != encoded:
            raise ValueError('noncanonical file base64')
        files.append(SnapshotFile(record['path'], record['mode'], content))
    result = tuple(files)
    verify(result, expected_manifest_hash, expected_tree)
    if encode_frame(result, expected_manifest_hash=expected_manifest_hash, expected_tree=expected_tree) != raw:
        raise ValueError('noncanonical complete inventory order')
    return result
