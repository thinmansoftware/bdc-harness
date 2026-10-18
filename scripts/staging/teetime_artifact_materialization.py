"""Pure artifact-to-frame join. Caller must separately prove SDK outcome/custody."""
from dataclasses import dataclass

from teetime_artifact_contract import parse_artifact
from teetime_materialization_frame import encode_frame

MAX_CONTROLLER_INPUT = 65536


@dataclass(frozen=True)
class PreparedMaterialization:
    raw_artifact_hash: str
    binding_hash: str
    manifest_hash: str
    source_tree: str
    frame: bytes


def prepare_materialization(raw_artifact, *, base_files, expected_binding, allowed_paths):
    candidate = parse_artifact(raw_artifact, base_files=base_files,
        expected_binding=expected_binding, allowed_paths=allowed_paths)
    frame = encode_frame(candidate.files, expected_manifest_hash=candidate.manifest_hash,
                         expected_tree=candidate.source_tree)
    if len(frame) > MAX_CONTROLLER_INPUT:
        raise ValueError('complete candidate exceeds controller transport bound')
    return PreparedMaterialization(candidate.artifact_hash, candidate.binding_hash,
                                   candidate.manifest_hash, candidate.source_tree, frame)
