"""Source-only v2 closure. Matching data is not execution or account authority."""
import hashlib
from pathlib import Path
import re
from teetime_joined_fixture import strict_json
from teetime_minimal_protocol import ALL_PATHS, IMAGE_PATHS
from teetime_successor_observation import frozen_file

V2_IMAGE_PATHS = tuple(dict.fromkeys((*IMAGE_PATHS, 'packages/providers/src/codex/sdk-failure-evidence.ts')))
# Host verifier imports host-only reconciliation helpers; never copy it alone
# into the worker image or claim that the worker can independently import it.
V2_ALL_PATHS = tuple(dict.fromkeys((*ALL_PATHS, *V2_IMAGE_PATHS,
                                  'scripts/staging/teetime_minimal_v2_contract.py',
                                  'scripts/staging/teetime_minimal_pc_envelope.py')))


def verify_v2_closure(root, raw, *, expected_manifest_hash, source, base_source):
    """Expected hash must come from a future independently frozen execution packet.

    This read-only verifier has no CLI, admission path or account access. Its caller
    must establish that external authority; an arbitrary matching hash is not it.
    """
    if (type(raw) is not bytes or not 1 <= len(raw) <= 16384 or not raw.isascii()
            or type(expected_manifest_hash) is not str
            or re.fullmatch('[a-f0-9]{64}', expected_manifest_hash) is None
            or hashlib.sha256(raw).hexdigest() != expected_manifest_hash):
        raise ValueError('frozen v2 closure bytes required')
    value = strict_json(raw)
    if (type(value) is not dict or set(value) != {'version', 'kind', 'source', 'baseSource', 'fileHashes'}
            or type(value['version']) is not int or value['version'] != 2
            or value['kind'] != 'teetime-minimal-source-v2' or value['source'] != source
            or value['baseSource'] != base_source
            or any(type(item) is not str or re.fullmatch('[a-f0-9]{40}', item) is None for item in [source, base_source])):
        raise ValueError('closed v2 source identity required')
    hashes = value['fileHashes']
    if (type(hashes) is not dict or set(hashes) != set(V2_ALL_PATHS)
            or any(type(item) is not str or re.fullmatch('[a-f0-9]{64}', item) is None for item in hashes.values())):
        raise ValueError('complete v2 selected closure required')
    for name in V2_ALL_PATHS:
        frozen_file(Path(root)/name, 'sha256:'+hashes[name], 262144)
    return dict(hashes)
