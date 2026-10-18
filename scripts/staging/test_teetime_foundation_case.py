"""Synthetic data validation only; fixtures are not persisted run authority."""
from dataclasses import FrozenInstanceError
import copy
import hashlib
import json
import unittest

from teetime_foundation_case import parse_foundation_case, ASSET_REFERENCES, FOUNDATION_PATHS
from teetime_snapshot import SnapshotFile, snapshot_manifest
from teetime_git_objects import build_git_objects
from teetime_materialization_frame import encode_frame
from teetime_artifact_contract import canonical


def digest(raw): return hashlib.sha256(raw).hexdigest()
def manifest_hash(files): return digest(snapshot_manifest(files).encode('ascii'))
def tree(files): return build_git_objects(files,expected_format='sha1').root_tree


def bind_candidate(value,files):
    value['source']['candidateTree']=tree(files)
    value['source']['candidateManifestHash']=manifest_hash(files)
    value['source']['candidateFrameHash']=digest(encode_frame(files,expected_manifest_hash=manifest_hash(files),expected_tree=tree(files)))


def fixture():
    base=(SnapshotFile('README.md','100644',b'Synthetic fixture only\n'),)
    files=base+tuple(SnapshotFile(path,'100644',('fixture bytes for '+path+'\n').encode()) for path in FOUNDATION_PATHS)
    assets={section+'.'+field:canonical({'syntheticAsset':section+'.'+field}).encode('ascii')
            for section,field,_prefix in ASSET_REFERENCES}
    candidate={file.path:file for file in files}
    assets['dependencies.packageJsonHash']=candidate['package.json'].content
    assets['dependencies.bunLockHash']=candidate['bun.lock'].content
    value={'version':1,'kind':'teetime-foundation-case','caseId':'clean-foundation-v1',
           'binding':{'runId':'synthetic-run','nodeId':'synthetic-node','attempt':1,
                      'baseManifestHash':manifest_hash(base)},
           'governance':{'woId':'WO-TEETIME-FOUNDATION-01','harnessSource':'c'*40},
           'source':{'baseCommit':'a'*40,'runScopeCommit':'b'*40,'baseTree':tree(base),
                     'candidateTree':tree(files),'candidateManifestHash':manifest_hash(files)},
           'dependencies':{},'runtime':{},'execution':{}}
    value['source']['candidateFrameHash']=digest(encode_frame(files,expected_manifest_hash=manifest_hash(files),expected_tree=tree(files)))
    for section,field,prefix in ASSET_REFERENCES:
        value[section][field]=('sha256:' if prefix else '')+digest(assets[section+'.'+field])
    context={'binding':copy.deepcopy(value['binding']),'governance':copy.deepcopy(value['governance']),
             'baseSha':value['source']['baseCommit'],'runScopeSha':value['source']['runScopeCommit'],
             'baseTree':tree(base),'allowedPaths':{path:('100644',) for path in FOUNDATION_PATHS}}
    profile={section:copy.deepcopy(value[section]) for section in ['dependencies','runtime','execution']}
    return value,dict(expected_context=context,expected_profile=profile,complete_base_files=base,
                      complete_candidate_files=files,frozen_asset_bytes=assets)


class FoundationCaseTests(unittest.TestCase):
    def test_recomputed_readme_identity_still_cannot_modify_preserved_base(self):
        value,inputs=fixture()
        files=tuple(SnapshotFile(file.path,file.git_mode,b'changed readme') if file.path=='README.md' else file
                    for file in inputs['complete_candidate_files'])
        bind_candidate(value,files)
        with self.assertRaisesRegex(ValueError,'unmentioned base changed'):
            parse_foundation_case(canonical(value).encode(),**{**inputs,'complete_candidate_files':files})

    def test_new_source_rejects_nonascii_or_nul_even_with_recomputed_identities(self):
        for content in [b'nonascii-\xff',b'nul-\0']:
            value,inputs=fixture()
            files=tuple(SnapshotFile(file.path,file.git_mode,content) if file.path=='app/page.tsx' else file
                        for file in inputs['complete_candidate_files'])
            bind_candidate(value,files)
            with self.assertRaisesRegex(ValueError,'ASCII source without NUL'):
                parse_foundation_case(canonical(value).encode(),**{**inputs,'complete_candidate_files':files})

    def test_fixed_new_file_capabilities_and_case_collisions(self):
        value,inputs=fixture()
        files=inputs['complete_candidate_files']
        for candidate in [tuple(file for file in files if file.path!='app/page.tsx'),
                          files+(SnapshotFile('APP/page.tsx','100644',b'x'),)]:
            with self.assertRaises(ValueError):
                parse_foundation_case(canonical(value).encode(),**{**inputs,'complete_candidate_files':candidate})
        capabilities={**inputs['expected_context']['allowedPaths'],'app/page.tsx':('100755',)}
        with self.assertRaises(ValueError):
            parse_foundation_case(canonical(value).encode(),**{**inputs,'expected_context':{**inputs['expected_context'],'allowedPaths':capabilities}})

    def test_coordinated_echo_changes_still_require_original_asset_bytes(self):
        value,inputs=fixture()
        value['governance']['planApprovalHash']='d'*64
        inputs['expected_context']['governance']['planApprovalHash']='d'*64
        with self.assertRaisesRegex(ValueError,'asset identity mismatch'):
            parse_foundation_case(canonical(value).encode(),**inputs)
        value,inputs=fixture()
        value['execution']['commandProfileHash']='d'*64
        inputs['expected_profile']['execution']['commandProfileHash']='d'*64
        with self.assertRaisesRegex(ValueError,'asset identity mismatch'):
            parse_foundation_case(canonical(value).encode(),**inputs)
    def test_recomputed_candidate_identities_cannot_hide_package_or_lock_substitution(self):
        for path in ['package.json','bun.lock']:
            value,inputs=fixture()
            files=tuple(SnapshotFile(file.path,file.git_mode,b'changed complete dependency bytes')
                        if file.path==path else file for file in inputs['complete_candidate_files'])
            value['source']['candidateTree']=tree(files)
            value['source']['candidateManifestHash']=manifest_hash(files)
            value['source']['candidateFrameHash']=digest(encode_frame(files,expected_manifest_hash=manifest_hash(files),expected_tree=tree(files)))
            with self.assertRaisesRegex(ValueError,'frozen dependency declaration mismatch'):
                parse_foundation_case(canonical(value).encode(),**{**inputs,'complete_candidate_files':files})

    def test_aggregate_assets_and_complete_files_are_bounded(self):
        value,inputs=fixture()
        assets={key:b'x'*400000 for key in inputs['frozen_asset_bytes']}
        with self.assertRaisesRegex(ValueError,'aggregate asset bound'):
            parse_foundation_case(canonical(value).encode(),**{**inputs,'frozen_asset_bytes':assets})
        files=tuple(SnapshotFile(file.path,file.git_mode,b'x'*1048576) for file in inputs['complete_candidate_files'])
        with self.assertRaisesRegex(ValueError,'snapshot total bound'):
            parse_foundation_case(canonical(value).encode(),**{**inputs,'complete_candidate_files':files})

    def test_missing_expected_context_profile_assets_and_path_capabilities_fail(self):
        value,inputs=fixture()
        for patch in [{'expected_context':None},{'expected_profile':{}},{'frozen_asset_bytes':None},
                      {'expected_context':{**inputs['expected_context'],'allowedPaths':{}}},
                      {'expected_context':{**inputs['expected_context'],'allowedPaths':{path:['100644'] for path in FOUNDATION_PATHS}}}]:
            with self.assertRaises(ValueError): parse_foundation_case(canonical(value).encode(),**{**inputs,**patch})
    def test_validates_immutable_data_without_granting_authority(self):
        value,inputs=fixture()
        raw=canonical(value).encode('ascii')
        result=parse_foundation_case(raw,**inputs)
        self.assertEqual(result.manifest_bytes,raw)
        self.assertEqual(result.manifest_sha256,digest(raw))
        self.assertFalse(hasattr(result,'approved'))
        self.assertFalse(hasattr(result,'ready'))
        with self.assertRaises(FrozenInstanceError): result.manifest_sha256='d'*64
        inputs['expected_context']['binding']['runId']='changed-after-call'
        inputs['frozen_asset_bytes'].clear()
        self.assertEqual(result.manifest_bytes,raw)

    def test_foreign_binding_governance_profile_case_or_source_fails(self):
        value,inputs=fixture()
        for section,key,replacement in [('binding','runId','foreign'),('binding','attempt',True),
          ('governance','woId','WO-OTHER'),('governance','harnessSource','d'*40),
          ('governance','planApprovalHash','d'*64),('binding','policyHash','sha256:'+'d'*64),
          ('source','baseCommit','d'*40),('source','runScopeCommit','a'*40),
          ('source','candidateTree','d'*40),('source','candidateFrameHash','d'*64),
          ('dependencies','packageJsonHash','d'*64),('runtime','imageInventoryHash','d'*64),
          ('execution','commandProfileHash','d'*64)]:
            changed=copy.deepcopy(value);changed[section][key]=replacement
            with self.assertRaises(ValueError): parse_foundation_case(canonical(changed).encode(),**inputs)
        for patch in [{'caseId':'runtime-negative'},{'version':True},{'extra':'field'}]:
            with self.assertRaises(ValueError): parse_foundation_case(canonical({**value,**patch}).encode(),**inputs)

    def test_missing_extra_changed_or_unbounded_assets_fail(self):
        value,inputs=fixture()
        raw=canonical(value).encode()
        assets=inputs['frozen_asset_bytes']
        first=next(iter(assets))
        for changed in [{key:raw for key,raw in assets.items() if key!=first},
                        {**assets,'extra':b'unknown'}, {**assets,first:b'changed'},
                        {**assets,first:b''},{**assets,first:b'x'*1048577}]:
            with self.assertRaises(ValueError): parse_foundation_case(raw,**{**inputs,'frozen_asset_bytes':changed})

    def test_complete_candidate_modifications_additions_deletions_and_modes_fail(self):
        value,inputs=fixture()
        raw=canonical(value).encode()
        files=inputs['complete_candidate_files']
        candidates=[files[1:],files+(SnapshotFile('extra.ts','100644',b'x'),),
                    tuple(SnapshotFile(file.path,file.git_mode,b'changed') if file.path in ['README.md','package.json','bun.lock'] else file for file in files),
                    tuple(SnapshotFile(file.path,'100755',file.content) if file.path=='app/page.tsx' else file for file in files)]
        for candidate in candidates:
            with self.assertRaises(ValueError): parse_foundation_case(raw,**{**inputs,'complete_candidate_files':candidate})

    def test_canonical_duplicate_encoding_and_mutable_inputs_fail(self):
        value,inputs=fixture()
        raw=canonical(value).encode()
        for malformed in [raw+b'\n',json.dumps(value,indent=2).encode(),b'\xef\xbb\xbf'+raw,
                          raw.replace(b'"version":1',b'"version":1,"version":1'),
                          raw.replace(b'"version":1',b'"version":1,"\\u0076ersion":1'),
                          raw.replace(b'"attempt":1',b'"attempt":1,"attempt":1'),
                          raw.replace(b'"attempt":1',b'"attempt":NaN'),b'\xff',bytearray(raw),b'x'*65537]:
            with self.assertRaises(ValueError): parse_foundation_case(malformed,**inputs)
        nested=copy.deepcopy(value);nested['execution']['command']=['untrusted']
        with self.assertRaises(ValueError): parse_foundation_case(canonical(nested).encode(),**inputs)
        with self.assertRaises(ValueError): parse_foundation_case(('['*9+']'*9).encode(),**inputs)
        with self.assertRaises(ValueError):
            parse_foundation_case(raw,**{**inputs,'complete_candidate_files':list(inputs['complete_candidate_files'])})
        assets=inputs['frozen_asset_bytes']
        first=next(iter(assets))
        with self.assertRaises(ValueError):
            parse_foundation_case(raw,**{**inputs,'frozen_asset_bytes':{**assets,first:bytearray(assets[first])}})


if __name__=='__main__': unittest.main()
