"""Source-only selector, READY and separate result-schema rejection tests."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
import ast
from unittest.mock import patch

from teetime_auth_artifact_protocol import (
    ALL_PATHS, IMAGE_PATHS, artifact_hashes, artifact_identity, empty_worker_result,
    validate_selector, validate_ready, validate_worker_result, validate_report,
)
from teetime_fixed_artifact import expected_artifact, validate_task_result


class ArtifactProtocolTests(unittest.TestCase):
    def test_demo_ready_binds_package_and_cannot_downgrade_to_fixed_canary(self):
        import test_teetime_demo_execution as fixtures
        fixture=fixtures.DemoExecutionTests();fixture.setUp()
        execution=fixture.parse()
        hashes={**self.hashes,'packages/providers/src/codex/restricted-policy.ts':'b'*64}
        ready={**self.ready,'task':'supervised-demo','artifactContractHash':execution.package_hash,
               'image':execution.image,'sourceSha':execution.base_source,
               'artifactSourceSha':execution.source,'hashes':hashes}
        args=dict(nonce=self.nonce,image=execution.image,base_source=execution.base_source,
                  source=execution.source,hashes=hashes)
        validate_ready(ready,**args,execution=execution)
        with self.assertRaises(ValueError): validate_ready(ready,**args)
        for key,value in [('task','artifact'),('artifactContractHash','0'*64),('image',self.image)]:
            with self.subTest(key=key),self.assertRaises(ValueError):
                validate_ready({**ready,key:value},**args,execution=execution)

    def test_demo_worker_reparses_candidate_and_rejects_edited_identity(self):
        import test_teetime_demo_execution as fixtures
        from teetime_demo_case import MODEL_PATHS,parse_demo_artifact
        fixture=fixtures.DemoExecutionTests();fixture.setUp();execution=fixture.parse()
        raw=json.dumps({'version':1,'binding':dict(execution.binding),'operations':[
            {'action':'write','path':path,'mode':'100644','baseHash':None,'content':'// source\n'}
            for path in MODEL_PATHS if path!='README.md']}).encode()
        candidate=parse_demo_artifact(raw,prepared=execution.prepared,expected_binding=dict(execution.binding))
        value=self.worker()
        value['workspaceDiagnostic']={'category':'unchanged','entryCount':2,'maskEntryCount':0}
        value.update({'artifactBase64':base64.b64encode(raw).decode(),'artifactHash':candidate.artifact_hash,
                      'bindingHash':candidate.binding_hash,'manifestHash':candidate.manifest_hash,
                      'sourceTree':candidate.source_tree,'elapsedMs':600000})
        actual=validate_worker_result(value,nonce=self.nonce,policy_hash='b'*64,execution=execution)
        self.assertEqual(actual.source_tree,candidate.source_tree)
        with self.assertRaises(ValueError): validate_worker_result(value,nonce=self.nonce,policy_hash='b'*64)
        with self.assertRaises(ValueError):
            validate_worker_result({**value,'sourceTree':'0'*40},nonce=self.nonce,policy_hash='b'*64,execution=execution)

    def test_demo_workspace_diagnostics_are_closed_bounded_and_consistent(self):
        import test_teetime_demo_execution as fixtures
        fixture=fixtures.DemoExecutionTests();fixture.setUp();execution=fixture.parse()
        value=empty_worker_result(demo=True)
        value['workspaceDiagnostic']={'category':'inventory_changed','entryCount':17,'maskEntryCount':0}
        validate_worker_result(value,nonce=self.nonce,policy_hash='b'*64,execution=execution)
        for diagnostic in [{'category':'private-file-name','entryCount':2,'maskEntryCount':0},
                           {'category':'inventory_changed','entryCount':18,'maskEntryCount':0},
                           {'category':'unchanged','entryCount':2,'maskEntryCount':0},
                           {'category':'inspection_failed','entryCount':0,'maskEntryCount':0,'path':'private'}]:
            with self.subTest(diagnostic=diagnostic),self.assertRaises(ValueError):
                validate_worker_result({**value,'workspaceDiagnostic':diagnostic},
                                      nonce=self.nonce,policy_hash='b'*64,execution=execution)

    def test_transitive_image_python_import_closure_is_frozen_and_measured(self):
        staging = Path(__file__).resolve().parent
        modules = {path.stem: path.name for path in staging.glob('*.py')}
        seen = set()
        pending = [path.removeprefix('scripts/staging/') for path in IMAGE_PATHS
                   if path.startswith('scripts/staging/') and path.endswith('.py')]
        while pending:
            name = pending.pop()
            if name in seen: continue
            seen.add(name)
            for node in ast.walk(ast.parse((staging/name).read_bytes())):
                imports = ([node.module] if isinstance(node, ast.ImportFrom) and node.module else
                           [alias.name for alias in node.names] if isinstance(node, ast.Import) else [])
                for module in imports:
                    dependency = modules.get(module.split('.')[0])
                    if dependency:
                        self.assertIn('scripts/staging/'+dependency, IMAGE_PATHS,
                                      name+' consumes unfrozen '+dependency)
                        pending.append(dependency)

    def test_isolated_worker_resolves_only_explicit_source_owned_helpers(self):
        staging = Path(__file__).resolve().parent
        code = '''import importlib.util,os,sys
from pathlib import Path
root=Path(sys.argv[1])
assert str(root) not in sys.path
spec=importlib.util.spec_from_file_location('isolated_worker',root/'teetime_canary_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
worker.ROOT=root
os.environ['TEETIME_AUTH_ARTIFACT_SOURCE_SHA']='0'*40
try:worker.artifact_main('a'*32,'b'*40)
except ValueError as error:assert str(error)=='artifact image source rejected'
else:raise AssertionError('source rejection expected before any auth access')
print('isolated-artifact-import-ok')
'''
        result = subprocess.run([sys.executable, '-I', '-c', code, str(staging)],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout.splitlines(), [b'isolated-artifact-import-ok'])

    def setUp(self):
        self.nonce, self.source, self.base = 'a'*32, 'b'*40, 'c'*40
        self.policy = 'd'*64
        self.image = 'sha256:'+'e'*64
        self.hashes = {path: hashlib.sha256(path.encode()).hexdigest() for path in ALL_PATHS}
        self.hashes['packages/providers/src/codex/restricted-policy.ts'] = self.policy
        self.ready = {'type': 'READY', 'nonce': self.nonce, 'image': self.image,
            'sourceSha': self.base, 'owner': 'teetime-auth-'+'f'*12, 'manifestSha256': '1'*64,
            'workerId': '2'*64, 'gatewayId': '3'*64, 'hashes': self.hashes,
            'task': 'artifact', 'artifactSourceSha': self.source,
            'artifactContractHash': artifact_identity(self.nonce, self.policy)}

    def worker(self):
        raw = expected_artifact(self.nonce, self.policy)
        task = {'kind': 'fixed-artifact-v1', 'passed': True, 'artifactBase64': base64.b64encode(raw).decode(),
            'modelInvocations': 1, 'assistantCount': 1, 'resultCount': 1, 'thinkingCount': 0,
            'normalProviderEnd': True, 'providerIteratorClosed': True, 'aborted': False,
            'failureCategory': 'none', 'servedModelVerified': False}
        candidate = validate_task_result(0, json.dumps(task).encode(), nonce=self.nonce, policy_hash=self.policy)
        value = empty_worker_result()
        value.update(task)
        del value['kind']
        value.update({'taskStarted': True, 'preflightPassed': True, 'preflightChecks': 6,
            'authUnchanged': True, 'workspaceUnchanged': True, 'artifactVerified': True,
            'taskDiagnosticsPresent': True, 'artifactHash': candidate.artifact_hash,
            'bindingHash': candidate.binding_hash, 'manifestHash': candidate.manifest_hash,
            'sourceTree': candidate.source_tree, 'oomKillDelta': 0})
        return value

    def check_ready(self, value):
        validate_ready(value, nonce=self.nonce, image=self.image, base_source=self.base,
            source=self.source, hashes=self.hashes)

    def test_closed_selector_and_complete_ready_binding(self):
        validate_selector('filesystem', None, self.nonce)
        validate_selector('artifact', self.source, self.nonce)
        for args in [('filesystem', self.source, self.nonce), ('artifact', None, self.nonce),
                     ('other', self.source, self.nonce), ('artifact', self.source, '../nonce')]:
            with self.assertRaises(ValueError):
                validate_selector(*args)
        self.check_ready(self.ready)
        for key, value in [('task', 'filesystem'), ('artifactSourceSha', 'c'*40), ('nonce', '0'*32),
            ('artifactContractHash', '0'*64), ('hashes', {}), ('image', 'sha256:'+'0'*64), ('extra', 1)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.check_ready({**self.ready, key: value})

    def test_archive_and_every_consumed_helper_must_match_before_ready(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            hashes = {}
            for path in ALL_PATHS:
                target = root/path; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(path.encode()); hashes[path] = hashlib.sha256(path.encode()).hexdigest()
            manifest = {'source': self.source, 'baseSource': self.base,
                        'baseImage': self.image, 'fileHashes': hashes}
            (root/'source-manifest.json').write_text(json.dumps(manifest))
            self.assertEqual(artifact_hashes(root/'scripts/staging', self.source, self.base), hashes)
            self.assertTrue(set(IMAGE_PATHS).issubset(hashes))
            (root/IMAGE_PATHS[0]).write_bytes(b'changed')
            with self.assertRaises(ValueError):
                artifact_hashes(root/'scripts/staging', self.source, self.base)

    def test_successful_worker_requires_independent_artifact_and_wrapper_evidence(self):
        value = self.worker()
        validate_worker_result(value, nonce=self.nonce, policy_hash=self.policy)
        for key, changed in [('authUnchanged', False), ('workspaceUnchanged', False),
            ('preflightChecks', 5), ('normalProviderEnd', False), ('aborted', True),
            ('servedModelVerified', True), ('artifactHash', '0'*64), ('oomKillDelta', 1),
            ('artifactBase64', base64.b64encode(b'foreign').decode()), ('extra', 1)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_worker_result({**value, key: changed}, nonce=self.nonce, policy_hash=self.policy)

    def test_synthetic_auth_rejection_is_distinct_and_cannot_carry_artifact(self):
        value = empty_worker_result()
        value.update({'preflightChecks': 5, 'authenticationRejected': True, 'authUnchanged': True,
                      'workspaceUnchanged': True, 'failureCategory': 'rejected', 'oomKillDelta': 0})
        validate_worker_result(value, nonce=self.nonce, policy_hash=self.policy)
        for key, changed in [('modelInvocations', 1), ('taskStarted', True), ('preflightPassed', True),
                             ('artifactBase64', 'YQ=='), ('artifactHash', '0'*64)]:
            with self.assertRaises(ValueError):
                validate_worker_result({**value, key: changed}, nonce=self.nonce, policy_hash=self.policy)

    def test_result_matches_ready_and_actual_process_exit_without_materialization(self):
        worker = self.worker()
        metrics = {'bytes': 1, 'header_or_destination_denied': 0, 'dns_denied': 0,
            'byte_limit': 0, 'timeout': 0, 'rejected_or_closed': 0, 'closed': 1}
        report = {'type': 'RESULT', 'nonce': self.nonce, 'owner': self.ready['owner'],
            'result': {'passed': True, 'cleanupVerified': True, 'credentialReceived': True,
                       'proxyMetricsVerified': True, 'artifactResult': worker},
            'cleanupErrors': [], 'receiptDirectory': 'owned-receipt', 'proxyMetrics': metrics,
            'task': 'artifact', 'artifactSourceSha': self.source,
            'artifactContractHash': self.ready['artifactContractHash']}
        validate_report(report, 0, ready=self.ready, policy_hash=self.policy)
        for code in [1, True, None]:
            with self.assertRaises(ValueError):
                validate_report(report, code, ready=self.ready, policy_hash=self.policy)
        for key, changed in [('task', 'filesystem'), ('owner', 'foreign'),
                             ('artifactContractHash', '0'*64), ('extra', 1)]:
            with self.assertRaises(ValueError):
                validate_report({**report, key: changed}, 0, ready=self.ready, policy_hash=self.policy)
        changed = copy.deepcopy(report); changed['result']['cleanupVerified'] = False
        with patch('teetime_auth_artifact_protocol.validate_task_result', side_effect=AssertionError('parsed before cleanup')), self.assertRaises(ValueError):
            validate_report(changed, 0, ready=self.ready, policy_hash=self.policy)
        failed = copy.deepcopy(report)
        failed['result']['passed'] = False
        failed['result']['artifactResult'] = empty_worker_result()
        failed['cleanupErrors'] = ['uncertain cleanup']
        with self.assertRaises(ValueError):
            validate_report(failed, 1, ready=self.ready, policy_hash=self.policy)

    def test_worker_invalid_selector_arguments_fail_before_auth_or_provider(self):
        script = str(Path(__file__).parent/'teetime_canary_worker.py')
        for flags in [['--task', 'artifact'], ['--task', 'artifact', '--nonce', 'invalid'],
            ['--task', 'filesystem', '--artifact-source', self.source],
            ['--task', 'filesystem', '--nonce', self.nonce]]:
            result = subprocess.run([sys.executable, '-I', script, *flags], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b'')


if __name__ == '__main__':
    unittest.main()
