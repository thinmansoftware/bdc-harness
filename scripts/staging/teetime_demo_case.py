"""Pure supervised demo preparation. No authority, acquisition or execution grant.

The trusted controller supplies original Git bytes/identities and reviewed asset
bytes/hashes separately. Caller echoes alone establish no provenance or approval.
Old foundation, fixed canary and generic materialization limits are unchanged.
"""
from dataclasses import dataclass
import hashlib
import re

from teetime_artifact_contract import MAX_ARTIFACT_BYTES, canonical, parse_artifact
from teetime_git_objects import build_git_objects
from teetime_materialization_frame import encode_frame
from teetime_snapshot import SnapshotFile, snapshot_manifest

MODEL_PATHS=('app/layout.tsx','app/page.tsx','app/globals.css','lib/demo.ts',
             'lib/courses.ts','tests/demo.test.ts','README.md')
ASSET_PATHS=('package.json','bun.lock','tsconfig.json','next-env.d.ts','next.config.mjs',
             'playwright.config.ts','playwright.staging.config.ts','walkthrough/demo.spec.ts','.gitignore')
MAX_PREPARED_ASSET_BYTES=32768
MAX_DEMO_FRAME=147456


def digest(raw):return hashlib.sha256(raw).hexdigest()


@dataclass(frozen=True)
class PreparedDemoBase:
    files: tuple[SnapshotFile,...]
    original_tree: str
    original_manifest_hash: str
    source_tree: str
    manifest_hash: str
    asset_hashes: tuple[tuple[str,str],...]


def candidate_frame_upper_bound(prepared):
    # Exact closed path-record overhead, fixed assets, and a conservative bound
    # for ALL model source content together. JSON escaping cannot compress input.
    paths=sorted(set(ASSET_PATHS)|set(MODEL_PATHS))
    frame={'version':1,'manifestHash':'0'*64,'sourceTree':'0'*40,
           'files':[{'path':name,'mode':'100644','contentBase64':''} for name in paths]}
    fixed=sum(4*((len(file.content)+2)//3) for file in prepared.files)
    model=4*((MAX_ARTIFACT_BYTES+2)//3)+4*(len(MODEL_PATHS)-1)
    return len(canonical(frame).encode('ascii'))+fixed+model


def prepare_demo_base(*,original_files,expected_original_tree,expected_original_manifest,
                      assets,expected_asset_hashes):
    original=tuple(original_files)
    if len(original)!=1 or original[0].path!='README.md' or original[0].git_mode!='100644':
        raise ValueError('reviewed README-only original required; changed base needs review')
    if re.fullmatch('[a-f0-9]{40}',expected_original_tree or '') is None or re.fullmatch('[a-f0-9]{64}',expected_original_manifest or '') is None:
        raise ValueError('original controller identities required')
    tree=build_git_objects(original,expected_format='sha1').root_tree
    manifest=digest(snapshot_manifest(original).encode('ascii'))
    if tree!=expected_original_tree or manifest!=expected_original_manifest:
        raise ValueError('original complete Git identity differs')
    if type(assets) is not dict or type(expected_asset_hashes) is not dict or set(assets)!=set(ASSET_PATHS) or set(expected_asset_hashes)!=set(ASSET_PATHS):
        raise ValueError('closed complete prepared asset map required')
    if set(file.path for file in original)&set(assets):raise ValueError('prepared asset collision')
    files=list(original);total=0
    for name in sorted(assets):
        raw=assets[name];expected=expected_asset_hashes[name]
        if type(raw) is not bytes or not raw or not raw.isascii() or b'\0' in raw:
            raise ValueError('immutable nonempty ASCII asset bytes required')
        total+=len(raw)
        if total>MAX_PREPARED_ASSET_BYTES:raise ValueError('finite prepared asset aggregate exceeded')
        if type(expected) is not str or re.fullmatch('[a-f0-9]{64}',expected) is None or digest(raw)!=expected:
            raise ValueError('prepared asset identity differs')
        files.append(SnapshotFile(name,'100644',bytes(raw)))
    frozen=tuple(sorted(files,key=lambda file:file.path))
    prepared=PreparedDemoBase(frozen,tree,manifest,
        build_git_objects(frozen,expected_format='sha1').root_tree,
        digest(snapshot_manifest(frozen).encode('ascii')),tuple(sorted(expected_asset_hashes.items())))
    if candidate_frame_upper_bound(prepared)>MAX_DEMO_FRAME:
        raise ValueError('complete demo frame cannot fit finite transport')
    return prepared


def parse_demo_artifact(raw,*,prepared,expected_binding):
    if not isinstance(prepared,PreparedDemoBase) or expected_binding.get('baseManifestHash')!=prepared.manifest_hash:
        raise ValueError('prepared base binding differs')
    candidate=parse_artifact(raw,base_files=prepared.files,expected_binding=expected_binding,
        allowed_paths={path:('100644',) for path in MODEL_PATHS})
    if set(file.path for file in candidate.files)!=set(ASSET_PATHS)|set(MODEL_PATHS):
        raise ValueError('required complete app source inventory missing')
    if any(file.git_mode!='100644' or not file.content for file in candidate.files):
        raise ValueError('nonempty ordinary complete app files required')
    frame=encode_frame(candidate.files,expected_manifest_hash=candidate.manifest_hash,expected_tree=candidate.source_tree)
    if len(frame)>MAX_DEMO_FRAME:raise ValueError('complete demo frame exceeded')
    return candidate
