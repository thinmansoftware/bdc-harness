"""Reject SDK receipts before any materialization resource is created."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import probe_teetime_joined as controller
from teetime_joined_fixture import SDK_HELPERS, joined_base, joined_binding, validate_sdk_output
from teetime_snapshot import snapshot_manifest


class JoinedTests(unittest.TestCase):
    def setUp(self):
        self.owner = 'teetime-fs-'+'a'*12
        self.image = 'sha256:'+'b'*64
        self.source = 'c'*40
        self.base_source = 'd'*40
        self.hashes = {path: hashlib.sha256(path.encode()).hexdigest() for path in SDK_HELPERS}
        self.binding = joined_binding(self.owner, self.hashes['packages/providers/src/codex/restricted-policy.ts'])
        raw = json.dumps({'version': 1, 'binding': self.binding, 'operations': [
            {'action': 'write', 'path': 'index.html', 'baseHash': None, 'mode': '100644',
             'content': '<p>synthetic-artifact-ready</p>\n'}]}, separators=(',', ':')).encode()
        self.raw = raw
        self.sdk = {'kind': 'result', 'accepted': True, 'bytesBase64': base64.b64encode(raw).decode(),
            'intercepted': 1, 'threads': 1, 'optionsVerified': True, 'threadOptionsVerified': True,
            'importIntercepted': True, 'normalProviderEnd': True, 'providerIteratorClosed': True,
            'counts': {'assistant': 1, 'result': 1}, 'abortedBeforeCleanup': False,
            'phase': 'complete', 'errorName': None, 'errorCode': None}
        self.result = {'diagnosticPassed': True, 'case': 'success',
            'operations': {'requests': 1, 'websocketUpgradeAttempts': 7, 'errors': [], 'modelVerified': True},
            'sdk': self.sdk, 'candidateVerified': True, 'syntheticAuthUnchanged': True,
            'credentialsUsed': False, 'realProviderRequests': 0, 'workspaceUnchanged': True,
            'deviations': ['loopback base URL', 'synthetic API credential', 'proxy variables removed'],
            'observableBoundary': 'provider chunks; normalizer does not expose raw events after first completion'}
        self.report = {'imageId': self.image, 'sourceSha': self.base_source,
            'probeSha256': self.hashes[SDK_HELPERS[0]], 'pidsLimit': 128, 'result': self.result,
            'artifactSourceSha': self.source, 'artifactFileHashes': self.hashes,
            'fixtureOwner': self.owner, 'joinedFixture': True}
        self.cleanup = {'receiptDirectory': str(Path.home()/self.owner), 'cleanupVerified': True}

    def output(self):
        return (json.dumps(self.report)+'\n'+json.dumps(self.cleanup)+'\n').encode()

    def validate(self, code=0, output=None):
        return validate_sdk_output(code, self.output() if output is None else output,
            owner=self.owner, image=self.image, source=self.source, base_source=self.base_source,
            helper_hashes=self.hashes)

    def test_exact_artifact_frame_and_binding_recomputed_outside_worker(self):
        prepared = self.validate()
        self.assertEqual(prepared.raw_artifact_hash, hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(self.binding['baseManifestHash'],
            hashlib.sha256(snapshot_manifest(joined_base()).encode()).hexdigest())
        self.assertIn(b'index.html', prepared.frame)
        self.assertEqual(self.validate(output=self.output().replace(b'\n', b'\r\n')), prepared)

    def test_nonzero_cannot_be_salvaged_by_valid_report(self):
        for code in [1, 73, -9, True, None]:
            with self.subTest(code=code), self.assertRaises(ValueError):
                self.validate(code)

    def test_exact_two_frames_no_duplicates_extras_or_missing_cleanup(self):
        output = self.output()
        for changed in [output.splitlines(keepends=True)[0], output+output.splitlines(keepends=True)[1],
                        output+b'\n', output[:-1], output.replace(b'"pidsLimit": 128', b'"pidsLimit": 128,"pidsLimit":128'),
                        b'x'*16385, output.replace(b'"cleanupVerified": true', b'"cleanupVerified": 1')]:
            with self.subTest(changed=changed[:50]), self.assertRaises(ValueError):
                self.validate(output=changed)

    def test_foreign_identity_helpers_owner_and_cleanup_rejected(self):
        original = copy.deepcopy(self.report)
        for key, changed in [('imageId', 'sha256:'+'e'*64), ('sourceSha', 'e'*40),
            ('artifactSourceSha', 'e'*40), ('fixtureOwner', 'teetime-fs-'+'f'*12),
            ('probeSha256', 'f'*64), ('artifactFileHashes', {}), ('joinedFixture', False), ('extra', 1)]:
            self.report = {**original, key: changed}
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()
        self.report = original
        self.cleanup['receiptDirectory'] = str(Path.home()/'foreign')
        with self.assertRaises(ValueError):
            self.validate()

    def test_completion_counts_options_abort_and_provider_result_required(self):
        for key, changed in [('accepted', False), ('counts', {'assistant': 2}),
            ('normalProviderEnd', False), ('providerIteratorClosed', False), ('abortedBeforeCleanup', True),
            ('intercepted', True), ('threads', 2), ('optionsVerified', False), ('errorName', 'Error'),
            ('bytesBase64', 'not base64')]:
            self.result['sdk'] = {**self.sdk, key: changed}
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()
        self.result['sdk'] = self.sdk
        self.result['credentialsUsed'] = True
        with self.assertRaises(ValueError):
            self.validate()

    def test_foreign_raw_binding_rejected_even_with_valid_sdk_claims(self):
        foreign = json.loads(self.raw)
        foreign['binding']['runId'] = 'teetime-fs-'+'f'*12
        self.sdk['bytesBase64'] = base64.b64encode(json.dumps(foreign).encode()).decode()
        with self.assertRaises(ValueError):
            self.validate()

    def test_prephase_failures_never_call_materialization(self):
        args = SimpleNamespace(docker='docker', builder_image=self.image,
            image='sha256:'+'e'*64, source=self.source, base_source=self.base_source, case='clean')
        for failure in [TimeoutError('timeout'), ValueError('output bound'), (1, self.output()),
                        (0, self.output().splitlines(keepends=True)[0]), (0, b'x'*16385)]:
            with self.subTest(failure=str(failure)[:30]), patch.object(controller, 'freeze_helpers', return_value=self.hashes), \
                patch.object(controller.uuid, 'uuid4', return_value=SimpleNamespace(hex='a'*32)), \
                patch.object(controller, 'require_sdk_absent'), \
                patch.object(controller, 'cleanup_sdk', return_value=None) as clean, \
                patch.object(controller, 'capture', side_effect=failure if isinstance(failure, Exception) else None,
                             return_value=failure if isinstance(failure, tuple) else None), \
                patch.object(controller, 'materialize_run') as materialize:
                with self.assertRaises((TimeoutError, ValueError)):
                    controller.run(args)
                clean.assert_called_once()
                materialize.assert_not_called()

    def test_cleanup_failure_blocks_materialization_and_foreign_target_never_removed(self):
        args = SimpleNamespace(docker='docker', builder_image=self.image,
            image='sha256:'+'e'*64, source=self.source, base_source=self.base_source, case='clean')
        with patch.object(controller, 'freeze_helpers', return_value=self.hashes), \
            patch.object(controller.uuid, 'uuid4', return_value=SimpleNamespace(hex='a'*32)), \
            patch.object(controller, 'require_sdk_absent'), \
            patch.object(controller, 'cleanup_sdk', side_effect=ValueError('foreign identity')), \
            patch.object(controller, 'capture', return_value=(0, self.output())), \
            patch.object(controller, 'materialize_run') as materialize:
            with self.assertRaises(ValueError):
                controller.run(args)
            materialize.assert_not_called()
        info = {'name': '/'+self.owner, 'image': 'sha256:'+'f'*64, 'owner': self.owner}
        with patch.object(controller, 'docker_call', side_effect=[b'd'*64+b'\n', json.dumps(info).encode()]) as call:
            with self.assertRaises(ValueError):
                controller.cleanup_sdk('docker', self.owner, self.image)
            self.assertFalse(any('rm' in item.args for item in call.call_args_list))

    def test_success_passes_same_prepared_bytes_to_materializer_after_cleanup(self):
        args = SimpleNamespace(docker='docker', builder_image=self.image,
            image='sha256:'+'e'*64, source=self.source, base_source=self.base_source, case='clean')
        events = []
        with patch.object(controller, 'freeze_helpers', return_value=self.hashes), \
            patch.object(controller.uuid, 'uuid4', return_value=SimpleNamespace(hex='a'*32)), \
            patch.object(controller, 'require_sdk_absent'), \
            patch.object(controller, 'cleanup_sdk', side_effect=lambda *a: events.append('cleanup')), \
            patch.object(controller, 'capture', return_value=(0, self.output())), \
            patch.object(controller, 'materialize_run', side_effect=lambda *a, **kw: events.append('materialize')) as materialize:
            controller.run(args)
        self.assertEqual(events, ['cleanup', 'materialize'])
        self.assertEqual(materialize.call_args.kwargs['prepared'], self.validate())
        evidence = materialize.call_args.kwargs['sdk_evidence']
        self.assertEqual(base64.b64decode(evidence['sdkOutputBase64']), self.output())
        self.assertEqual(evidence['sdkOutputHash'], hashlib.sha256(self.output()).hexdigest())

    def test_existing_owned_name_is_not_reused_or_removed(self):
        args = SimpleNamespace(docker='docker', builder_image=self.image,
            image='sha256:'+'e'*64, source=self.source, base_source=self.base_source, case='clean')
        with patch.object(controller, 'freeze_helpers', return_value=self.hashes), \
            patch.object(controller, 'require_sdk_absent', side_effect=ValueError('exists')), \
            patch.object(controller, 'cleanup_sdk') as clean, patch.object(controller, 'capture') as child, \
            patch.object(controller, 'materialize_run') as materialize:
            with self.assertRaises(ValueError):
                controller.run(args)
            clean.assert_not_called()
            child.assert_not_called()
            materialize.assert_not_called()

    def test_cleanup_removes_only_exact_image_name_and_owner_then_rechecks_absence(self):
        info = {'name': '/'+self.owner, 'image': self.image, 'owner': self.owner}
        for field in ['name', 'image', 'owner', None]:
            value = {**info, **({field: 'foreign'} if field else {})}
            responses = [b'd'*64+b'\n', json.dumps(value).encode(), b'', b'', b'']
            with self.subTest(field=field), patch.object(controller, 'docker_call', side_effect=responses) as call:
                if field:
                    with self.assertRaises(ValueError):
                        controller.cleanup_sdk('docker', self.owner, self.image)
                    self.assertFalse(any('rm' in item.args for item in call.call_args_list))
                else:
                    controller.cleanup_sdk('docker', self.owner, self.image)
                    self.assertEqual(call.call_args_list[2].args, ('docker', 'rm', '-f', 'd'*64))
                    self.assertEqual(call.call_count, 5)

    def test_frozen_manifest_binds_every_controller_dependency_before_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hashes = {}
            for path in controller.FROZEN_HELPERS:
                target = root/path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.encode())
                hashes[path] = hashlib.sha256(path.encode()).hexdigest()
            manifest = {'source': self.source, 'baseSource': self.base_source,
                        'baseImage': self.image, 'fileHashes': hashes}
            (root/'source-manifest.json').write_text(json.dumps(manifest))
            with patch.object(controller, 'ROOT', root):
                self.assertEqual(controller.freeze_helpers(self.source, self.base_source),
                                 {path: hashes[path] for path in SDK_HELPERS})
                for source in ['branch', 'f'*40]:
                    with self.assertRaises(ValueError):
                        controller.freeze_helpers(source, self.base_source)
                (root/'scripts/staging/probe_teetime_joined.py').write_bytes(b'changed')
                with self.assertRaises(ValueError):
                    controller.freeze_helpers(self.source, self.base_source)

    def test_joined_cli_cannot_be_used_as_arbitrary_fixture_identity(self):
        script = str(Path(__file__).parent/'probe-teetime-filesystem.py')
        base = [sys.executable, '-I', script, '--docker', 'never-run-docker',
                '--image', self.image, '--expected-sha', self.base_source]
        for flags in [['--artifact-joined'], ['--fixture-owner', self.owner],
            ['--artifact-import-only', '--artifact-joined', '--fixture-owner', self.owner],
            ['--artifact-fixture', '--artifact-joined', '--fixture-owner', 'foreign']]:
            result = subprocess.run([*base, *flags], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertIn(b'error:', result.stderr)


if __name__ == '__main__':
    unittest.main()
