"""Prepared-base collision/identity/capability tests; no model or filesystem writes."""
import hashlib
import json
from pathlib import Path
import unittest

from teetime_artifact_contract import canonical, MAX_ARTIFACT_BYTES
from teetime_git_objects import build_git_objects
from teetime_snapshot import SnapshotFile, snapshot_manifest
from teetime_demo_case import prepare_demo_base, parse_demo_artifact, MODEL_PATHS, ASSET_PATHS


class DemoCaseTests(unittest.TestCase):
    def setUp(self):
        self.original = (SnapshotFile('README.md', '100644', b'Simulated original\n'),)
        self.tree = build_git_objects(self.original, expected_format='sha1').root_tree
        self.manifest = hashlib.sha256(snapshot_manifest(self.original).encode('ascii')).hexdigest()
        self.assets = {name: ('Frozen ' + name + '\n').encode() for name in ASSET_PATHS}
        self.hashes = {name: hashlib.sha256(data).hexdigest() for name, data in self.assets.items()}

    def prepare(self, **overrides):
        args = dict(original_files=self.original, expected_original_tree=self.tree,
                    expected_original_manifest=self.manifest, assets=self.assets,
                    expected_asset_hashes=self.hashes)
        return prepare_demo_base(**{**args, **overrides})

    def test_prepared_base_retains_both_identities_and_copies_mutable_inputs(self):
        prepared = self.prepare()
        self.assertEqual(prepared.original_tree, self.tree)
        self.assertEqual(prepared.original_manifest_hash, self.manifest)
        self.assertNotEqual(prepared.manifest_hash, self.manifest)
        self.assertEqual(set(file.path for file in prepared.files), set(ASSET_PATHS) | {'README.md'})
        self.assets['package.json'] = b'changed'
        self.assertNotEqual(next(file.content for file in prepared.files if file.path == 'package.json'), b'changed')
        self.assertEqual(prepared.asset_hashes, tuple(sorted(self.hashes.items())))

    def test_original_or_asset_drift_and_collisions_fail_closed(self):
        for changes in [dict(expected_original_tree='0' * 40), dict(expected_original_manifest='0' * 64),
                        dict(assets={**self.assets, 'extra': b'extra'}),
                        dict(assets={**self.assets, 'package.json': b'changed'}),
                        dict(original_files=(*self.original, SnapshotFile('package.json', '100644', b'collision')))]:
            with self.subTest(changes=list(changes)), self.assertRaises(ValueError):
                self.prepare(**changes)

    def test_full_artifact_preserves_prepared_assets_and_rejects_immutable_edits(self):
        prepared = self.prepare()
        binding = {'runId': 'real-run', 'nodeId': 'implement', 'attempt': 1,
                   'authorityHash': 'sha256:' + 'a' * 64, 'policyHash': 'sha256:' + 'b' * 64,
                   'baseManifestHash': prepared.manifest_hash}
        operations = [{'action': 'write', 'path': name, 'baseHash': None, 'mode': '100644', 'content': '// new source\n'}
                      for name in MODEL_PATHS if name != 'README.md']
        raw = canonical({'version': 1, 'binding': binding, 'operations': operations}).encode()
        candidate = parse_demo_artifact(raw, prepared=prepared, expected_binding=binding)
        self.assertTrue(all(file in candidate.files for file in prepared.files))
        forbidden = {**operations[0], 'path': 'package.json', 'baseHash': self.hashes['package.json']}
        raw = canonical({'version': 1, 'binding': binding, 'operations': [*operations, forbidden]}).encode()
        with self.assertRaises(ValueError):
            parse_demo_artifact(raw, prepared=prepared, expected_binding=binding)
        complete = [{'action': 'write', 'path': name, 'baseHash': None, 'mode': '100644', 'content': '// new source\n'}
                    for name in MODEL_PATHS if name != 'README.md']
        complete.append({'action': 'delete', 'path': 'README.md', 'baseHash': self.original[0].sha256})
        raw = canonical({'version': 1, 'binding': binding, 'operations': complete}).encode()
        with self.assertRaises(ValueError):
            parse_demo_artifact(raw, prepared=prepared, expected_binding=binding)

    def test_missing_required_source_and_deleted_readme_are_not_complete_demo(self):
        prepared = self.prepare()
        binding = {'runId': 'real-run', 'nodeId': 'implement', 'attempt': 1,
                   'authorityHash': 'sha256:' + 'a' * 64, 'policyHash': 'sha256:' + 'b' * 64,
                   'baseManifestHash': prepared.manifest_hash}
        op = {'action': 'write', 'path': 'app/page.tsx', 'baseHash': None, 'mode': '100644', 'content': '// partial\n'}
        raw = canonical({'version': 1, 'binding': binding, 'operations': [op]}).encode()
        with self.assertRaises(ValueError):
            parse_demo_artifact(raw, prepared=prepared, expected_binding=binding)

    def test_actual_assets_fit_finite_candidate_frame_bound(self):
        case = json.loads(Path(__file__).with_name('teetime-demo-case.json').read_text())
        folder = Path(__file__).with_name('teetime-demo-assets')
        self.assertEqual(set(case['modelPaths']), set(MODEL_PATHS))
        self.assertEqual(set(case['preparedAssets']), set(ASSET_PATHS))
        self.assets = {name: (folder / source).read_bytes() for name, source in case['preparedAssets'].items()}
        self.hashes = {name: hashlib.sha256(data).hexdigest() for name, data in self.assets.items()}
        prepared = self.prepare()
        from teetime_demo_case import candidate_frame_upper_bound, MAX_DEMO_FRAME
        self.assertLessEqual(candidate_frame_upper_bound(prepared), MAX_DEMO_FRAME)
        self.assertGreater(candidate_frame_upper_bound(prepared), 65536)

    def test_maximum_model_envelope_plus_complete_actual_assets_fits(self):
        case = json.loads(Path(__file__).with_name('teetime-demo-case.json').read_text())
        folder = Path(__file__).with_name('teetime-demo-assets')
        self.assets = {name: (folder / source).read_bytes() for name, source in case['preparedAssets'].items()}
        self.hashes = {name: hashlib.sha256(data).hexdigest() for name, data in self.assets.items()}
        prepared = self.prepare()
        binding = {'runId': 'real-run', 'nodeId': 'implement', 'attempt': 1,
                   'authorityHash': 'sha256:' + 'a' * 64, 'policyHash': 'sha256:' + 'b' * 64,
                   'baseManifestHash': prepared.manifest_hash}
        operations = [{'action': 'write', 'path': name, 'baseHash': None, 'mode': '100644', 'content': 'x'}
                      for name in MODEL_PATHS if name != 'README.md']
        def encoded():return canonical({'version': 1, 'binding': binding, 'operations': operations}).encode()
        operations[0]['content'] += 'x' * (MAX_ARTIFACT_BYTES - len(encoded()))
        self.assertEqual(len(encoded()), MAX_ARTIFACT_BYTES)
        candidate = parse_demo_artifact(encoded(), prepared=prepared, expected_binding=binding)
        self.assertEqual(len(candidate.files), len(set(ASSET_PATHS) | set(MODEL_PATHS)))
        operations[0]['content'] += 'x'
        with self.assertRaises(ValueError):
            parse_demo_artifact(encoded(), prepared=prepared, expected_binding=binding)


if __name__ == '__main__':
    unittest.main()
