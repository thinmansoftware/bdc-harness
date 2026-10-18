"""Pure pre-build data binding. No custody, approval, acquisition or runtime proof.

Expected context/profile and complete bytes must come separately from the trusted
controller after its admission checks. Matching caller-supplied echoes authenticates
nothing. This unregistered parser performs no filesystem/process/network operation.
"""
from dataclasses import dataclass
import hashlib
import json
import re

from teetime_artifact_contract import canonical, exact_object, unique_object, reject_constant, validate_depth, validate_binding
from teetime_git_objects import build_git_objects
from teetime_materialization_frame import encode_frame
from teetime_snapshot import MAX_FILE, MAX_TOTAL, snapshot_manifest


FOUNDATION_PATHS=('package.json','bun.lock','tsconfig.json','next-env.d.ts','next.config.ts',
                  'app/layout.tsx','app/page.tsx','app/not-found.tsx','app/api/health/route.ts',
                  'tests/foundation.test.ts','tests/foundation-http.test.ts')
ASSET_REFERENCES=(
    ('binding','authorityHash',True),('binding','policyHash',True),
    ('governance','specHash',True),('governance','planHash',False),
    ('governance','planApprovalHash',False),('governance','workflowDigest',False),
    ('governance','qualificationScopeHash',False),
    ('dependencies','packageJsonHash',False),('dependencies','bunLockHash',False),
    ('dependencies','preparedInventoryHash',False),('dependencies','cacheInventoryHash',False),
    ('dependencies','lifecyclePolicyHash',False),
    ('runtime','imageInventoryHash',False),('runtime','executableInventoryHash',False),
    ('runtime','browserInventoryHash',False),('runtime','osInventoryHash',False),
    ('execution','commandProfileHash',False),('execution','environmentProfileHash',False),
    ('execution','resourceProfileHash',False),('execution','ownershipProfileHash',False),
    ('execution','cleanupProfileHash',False),('execution','outputProfileHash',False))
GOVERNANCE={'woId','specHash','planHash','planApprovalHash','workflowDigest','harnessSource','qualificationScopeHash'}
SOURCE={'baseCommit','runScopeCommit','baseTree','candidateTree','candidateManifestHash','candidateFrameHash'}
PROFILE_SECTIONS=('dependencies','runtime','execution')


@dataclass(frozen=True)
class ValidatedFoundationData:
    manifest_bytes: bytes
    manifest_sha256: str


def digest(raw): return hashlib.sha256(raw).hexdigest()


def closed(value,keys):
    # Bound even separately supplied trusted mappings before set allocation.
    if type(value) is not dict or len(value)!=len(keys):
        raise ValueError('foundation closed object rejected')
    exact_object(value,keys)


def identity(value,size=64,prefix=''):
    if type(value) is not str or re.fullmatch(re.escape(prefix)+'[a-f0-9]{'+str(size)+'}',value) is None:
        raise ValueError('foundation identity rejected')


def governance(value):
    closed(value,GOVERNANCE)
    if value['woId']!='WO-TEETIME-FOUNDATION-01': raise ValueError('foundation WO rejected')
    identity(value['harnessSource'],40)
    for section,field,prefix in ASSET_REFERENCES:
        if section=='governance': identity(value[field],prefix='sha256:' if prefix else '')


def profile(value):
    closed(value,PROFILE_SECTIONS)
    for section in PROFILE_SECTIONS:
        fields={field for owner,field,_ in ASSET_REFERENCES if owner==section}
        closed(value[section],fields)
        for field in fields: identity(value[section][field])


def parse_foundation_case(raw_manifest_bytes,*,expected_context,expected_profile,
                          complete_base_files,complete_candidate_files,frozen_asset_bytes):
    raw=raw_manifest_bytes
    if type(raw) is not bytes or not 2<=len(raw)<=65536 or not raw.isascii():
        raise ValueError('foundation bounded ASCII bytes required')
    try:
        text=raw.decode('ascii')
        validate_depth(text)
        value=json.loads(text,object_pairs_hook=unique_object,parse_constant=reject_constant)
        if canonical(value).encode('ascii')!=raw: raise ValueError('noncanonical')
    except (ValueError,RecursionError,UnicodeError):
        raise ValueError('foundation strict canonical JSON rejected') from None
    closed(value,{'version','kind','caseId','binding','governance','source',*PROFILE_SECTIONS})
    if type(value['version']) is not int or value['version']!=1 or value['kind']!='teetime-foundation-case' or value['caseId']!='clean-foundation-v1':
        raise ValueError('foundation case rejected')

    closed(expected_context,{'binding','governance','baseSha','runScopeSha','baseTree','allowedPaths'})
    closed(expected_context['binding'],{'runId','nodeId','attempt','authorityHash','policyHash','baseManifestHash'})
    validate_binding(expected_context['binding'])
    validate_binding(value['binding'])
    governance(expected_context['governance'])
    governance(value['governance'])
    profile(expected_profile)
    profile({section:value[section] for section in PROFILE_SECTIONS})
    for field in ('baseSha','runScopeSha','baseTree'): identity(expected_context[field],40)
    if expected_context['baseSha']==expected_context['runScopeSha']:
        raise ValueError('foundation distinct run scope required')
    if value['binding']!=expected_context['binding'] or value['governance']!=expected_context['governance']:
        raise ValueError('foundation foreign context')
    if any(value[section]!=expected_profile[section] for section in PROFILE_SECTIONS):
        raise ValueError('foundation foreign profile')
    closed(value['source'],SOURCE)
    for field in SOURCE:
        identity(value['source'][field],40 if field in {'baseCommit','runScopeCommit','baseTree','candidateTree'} else 64)
    for field,expected in [('baseCommit','baseSha'),('runScopeCommit','runScopeSha'),('baseTree','baseTree')]:
        if value['source'][field]!=expected_context[expected]: raise ValueError('foundation foreign source')

    # The source-owned map has no extensions or hash-only unresolved references.
    asset_keys={section+'.'+field for section,field,_ in ASSET_REFERENCES}
    closed(frozen_asset_bytes,asset_keys)
    total=0
    for asset in frozen_asset_bytes.values():
        if type(asset) is not bytes or not 1<=len(asset)<=MAX_FILE:
            raise ValueError('foundation immutable bounded asset required')
        total+=len(asset)
        if total>MAX_TOTAL: raise ValueError('foundation aggregate asset bound')
    for section,field,prefix in ASSET_REFERENCES:
        expected=('sha256:' if prefix else '')+digest(frozen_asset_bytes[section+'.'+field])
        if value[section][field]!=expected: raise ValueError('foundation asset identity mismatch')

    # These constructors bound count/paths/case/prefix/modes/bytes before hashing.
    base_tree=build_git_objects(complete_base_files,expected_format='sha1').root_tree
    candidate_tree=build_git_objects(complete_candidate_files,expected_format='sha1').root_tree
    base={file.path:file for file in complete_base_files}
    candidate={file.path:file for file in complete_candidate_files}
    if any(file.git_mode!='100644' for file in (*complete_base_files,*complete_candidate_files)):
        raise ValueError('foundation regular nonexecutable source required')
    closed(expected_context['allowedPaths'],FOUNDATION_PATHS)
    if any(type(modes) is not tuple or modes!=('100644',) for modes in expected_context['allowedPaths'].values()):
        raise ValueError('foundation new-file capabilities rejected')
    if set(base)&set(FOUNDATION_PATHS) or set(candidate)!=set(base)|set(FOUNDATION_PATHS):
        raise ValueError('foundation addition/deletion capability mismatch')
    if any(not candidate[path].content.isascii() or b'\0' in candidate[path].content for path in FOUNDATION_PATHS):
        raise ValueError('foundation new files require ASCII source without NUL')
    if any(candidate[path]!=file for path,file in base.items()):
        raise ValueError('foundation unmentioned base changed')
    if base_tree!=value['source']['baseTree'] or digest(snapshot_manifest(complete_base_files).encode('ascii'))!=value['binding']['baseManifestHash']:
        raise ValueError('foundation complete base identity mismatch')
    manifest_hash=digest(snapshot_manifest(complete_candidate_files).encode('ascii'))
    if candidate_tree!=value['source']['candidateTree'] or manifest_hash!=value['source']['candidateManifestHash']:
        raise ValueError('foundation complete candidate identity mismatch')
    frame=encode_frame(complete_candidate_files,expected_manifest_hash=manifest_hash,expected_tree=candidate_tree)
    if digest(frame)!=value['source']['candidateFrameHash']:
        raise ValueError('foundation complete frame identity mismatch')
    for path,field in [('package.json','packageJsonHash'),('bun.lock','bunLockHash')]:
        if candidate[path].content!=frozen_asset_bytes['dependencies.'+field]:
            raise ValueError('foundation frozen dependency declaration mismatch')
    # No caller-owned mutable value is retained; there are no authority/result flags.
    return ValidatedFoundationData(bytes(raw),digest(raw))
