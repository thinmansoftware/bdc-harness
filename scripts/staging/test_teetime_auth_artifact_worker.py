"""Actual wrapper reads against temporary files; UID/preflight/model are synthetic."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from teetime_fixed_artifact import expected_artifact

SPEC = importlib.util.spec_from_file_location('artifact_worker', Path(__file__).parent/'teetime_canary_worker.py')
worker = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(worker)


class ArtifactWorkerTests(unittest.TestCase):
    def fixture(self, mode, demo=False):
        nonce, source = 'a'*32, 'b'*40
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); workspace = root/'workspace'; workspace.mkdir()
            (workspace/'.codex').mkdir(); (workspace/'.agents').mkdir()
            auth = root/'auth.json'; auth.write_bytes(b'private-test-auth')
            policy = root/'policy.ts'; policy.write_bytes(b'trusted fixture policy')
            policy_hash = hashlib.sha256(policy.read_bytes()).hexdigest()
            packet = {'kind': 'fixed-artifact-v1', 'passed': True,
                'artifactBase64': base64.b64encode(expected_artifact(nonce, policy_hash)).decode(),
                'modelInvocations': 1, 'assistantCount': 1, 'resultCount': 1, 'thinkingCount': 0,
                'normalProviderEnd': True, 'providerIteratorClosed': True, 'aborted': False,
                'failureCategory': 'none', 'servedModelVerified': False}
            execution=None
            if demo:
                import test_teetime_demo_execution as fixtures
                from teetime_demo_case import MODEL_PATHS
                fixture=fixtures.DemoExecutionTests();fixture.setUp()
                fixture.value['source']=source
                fixture.value['binding']['policyHash']='sha256:'+policy_hash
                execution=fixture.parse()
                artifact={'version':1,'binding':dict(execution.binding),'operations':[
                    {'action':'write','path':path,'baseHash':None,'mode':'100644','content':'// app\n'}
                    for path in MODEL_PATHS if path!='README.md']}
                packet['artifactBase64']=base64.b64encode(json.dumps(artifact).encode()).decode()
                del packet['passed'];del packet['failureCategory']
                packet.update({'kind':'supervised-demo-v1','collected':True})
            class FixturePath:
                def __new__(cls, value):
                    if value == '/workspace': return workspace
                    if value == '/app/packages/providers/src/codex/restricted-policy.ts': return policy
                    return root/('absent-'+str(value).replace('/', '-'))
                @staticmethod
                def cwd(): return workspace
            original_lstat = Path.lstat
            def normalized_lstat(path):
                actual = original_lstat(path)
                # Windows cannot represent Linux UID1001/0600; normalize only fixture metadata.
                if path == auth or path.parent == workspace:
                    return SimpleNamespace(st_mode=(stat.S_IFREG|0o600) if path == auth else (stat.S_IFDIR|0o755),
                        st_uid=1001, st_gid=1001, st_dev=actual.st_dev, st_ino=actual.st_ino, st_size=actual.st_size)
                return actual
            def preflight():
                worker.PREFLIGHT_CHECKS = 5 if mode == 'auth_rejection' else 6
                worker.AUTH_REJECTED = mode == 'auth_rejection'
                if mode == 'auth_rejection': raise ValueError('fixed synthetic auth failure')
                if mode == 'preflight_mutation': (workspace/'unexpected').write_bytes(b'private-data')
            def task(argv, timeout, **kwargs):
                self.assertEqual(argv[0], 'bun')
                if demo:
                    self.assertTrue(argv[-1].endswith('teetime-demo-task-entry.ts'))
                    self.assertGreaterEqual(timeout,610);self.assertLessEqual(timeout,625)
                    self.assertEqual(json.loads(kwargs['input_bytes'])['runId'],execution.binding['runId'])
                    self.assertIs(kwargs['include_exit_code'],True)
                else:
                    self.assertEqual(argv[-1], nonce);self.assertEqual(timeout, 100)
                if mode == 'changed_auth': auth.write_bytes(b'changed-private-auth')
                if mode == 'extra_file': (workspace/'unexpected').write_bytes(b'private-workspace-data')
                if mode == 'mask_file': (workspace/'.codex'/'hidden').write_bytes(b'private-hidden-data')
                if mode == 'timeout': raise TimeoutError('private exception must not escape')
                if mode == 'failed_packet':
                    packet.update(collected=False,artifactBase64=None,assistantCount=0,resultCount=0,
                        normalProviderEnd=False,providerIteratorClosed=True,
                        failureDiagnostic={'stage':'stream','exceptionCategory':'transport_hint','lastEvent':'none'})
                if mode in ['duplicate_assistant','duplicate_result','thinking_overflow']:
                    packet.update(collected=False,artifactBase64=None,normalProviderEnd=False,
                        providerIteratorClosed=True,assistantCount=0,resultCount=0,thinkingCount=0,
                        failureDiagnostic={'stage':'stream','exceptionCategory':'other','lastEvent':'thinking'})
                    key,event,count={'duplicate_assistant':('assistantCount','assistant',2),
                                     'duplicate_result':('resultCount','result',2),
                                     'thinking_overflow':('thinkingCount','thinking',65)}[mode]
                    packet[key]=count;packet['failureDiagnostic']['lastEvent']=event
                code=1 if mode in ['failed_packet','failure_success_exit','duplicate_assistant',
                                   'duplicate_result','thinking_overflow'] else 0
                raw=b'{"private":"must-not-escape"}' if mode=='malformed' else json.dumps(packet).encode()
                return (code,raw) if demo else raw
            with patch.object(worker, 'Path', FixturePath), patch.object(worker, 'AUTH', auth), \
                patch.object(worker.os, 'getuid', return_value=1001, create=True), \
                patch.object(Path, 'lstat', normalized_lstat), patch.object(worker, 'preflight', side_effect=preflight), \
                patch.object(worker, 'PREFLIGHT_CHECKS', 0), patch.object(worker, 'AUTH_REJECTED', False), \
                patch.object(worker, 'bounded_process', side_effect=task) as invoked, \
                patch.object(worker, 'oom_kills', side_effect=[0, 1 if mode == 'oom' else 0]), \
                patch.dict(worker.os.environ, {'TEETIME_AUTH_ARTIFACT_SOURCE_SHA': source}), \
                (patch.object(worker.time,'monotonic',side_effect=[1000,1020,1020]) if mode=='budget_exhaustion' else contextlib.nullcontext()), \
                contextlib.redirect_stdout(io.StringIO()) as output:
                status = worker.artifact_main(nonce, source,execution)
            return status, json.loads(output.getvalue()), invoked.call_count, output.getvalue()

    def test_demo_candidate_uses_bound_input_and_same_custody_checks(self):
        status,result,calls,_=self.fixture('valid',demo=True)
        self.assertEqual(status,0);self.assertEqual(calls,1);self.assertTrue(result['passed'])
        for mode in ['changed_auth','extra_file','mask_file','oom','timeout','malformed']:
            with self.subTest(mode=mode):
                status,result,calls,output=self.fixture(mode,demo=True)
                self.assertEqual(status,1);self.assertEqual(calls,1)
                self.assertIsNone(result['artifactBase64']);self.assertNotIn('private',output)

    def test_demo_preflight_time_cannot_consume_full_query_budget(self):
        status,result,calls,_=self.fixture('budget_exhaustion',demo=True)
        self.assertEqual(status,1);self.assertEqual(calls,0)
        self.assertFalse(result['taskStarted']);self.assertEqual(result['modelInvocations'],0)

    def test_failed_task_packet_retains_only_diagnostics_and_never_a_candidate(self):
        status,result,calls,raw=self.fixture('failed_packet',demo=True)
        self.assertEqual(status,1);self.assertEqual(calls,1)
        self.assertFalse(result['passed']);self.assertIsNone(result['artifactBase64'])
        self.assertTrue(result['taskDiagnosticsPresent']);self.assertEqual(result['modelInvocations'],1)
        self.assertEqual(result['taskFailureDiagnostic'],
            {'stage':'stream','exceptionCategory':'transport_hint','lastEvent':'none'})
        self.assertNotIn('private',raw)
        status,result,_,_=self.fixture('failure_success_exit',demo=True)
        self.assertEqual(status,1);self.assertIsNone(result['modelInvocations'])
        self.assertFalse(result['taskDiagnosticsPresent']);self.assertIsNone(result['taskFailureDiagnostic'])

    def test_exact_task_and_actual_unchanged_auth_workspace_pass(self):
        status, result, calls, _ = self.fixture('valid')
        self.assertEqual(status, 0); self.assertEqual(calls, 1)
        self.assertTrue(result['passed']); self.assertTrue(result['authUnchanged'])
        self.assertTrue(result['workspaceUnchanged']); self.assertIsNotNone(result['artifactBase64'])

    def test_rejected_stream_counts_survive_worker_and_outer_validation(self):
        import test_teetime_demo_execution as fixtures
        from teetime_auth_artifact_protocol import validate_worker_result
        for mode,key,count in [('duplicate_assistant','assistantCount',2),
                               ('duplicate_result','resultCount',2),('thinking_overflow','thinkingCount',65)]:
            with self.subTest(mode=mode):
                status,result,_,_=self.fixture(mode,demo=True)
                self.assertEqual(status,1);self.assertIsNone(result['artifactBase64'])
                self.assertTrue(result['taskDiagnosticsPresent']);self.assertEqual(result[key],count)
                fixture=fixtures.DemoExecutionTests();fixture.setUp();execution=fixture.parse()
                self.assertIsNone(validate_worker_result(result,nonce='a'*32,policy_hash='b'*64,execution=execution))

    def test_auth_workspace_mask_mutation_oom_and_bad_process_cannot_emit_bytes(self):
        for mode in ['changed_auth', 'extra_file', 'mask_file', 'oom', 'timeout', 'malformed']:
            with self.subTest(mode=mode):
                status, result, calls, output = self.fixture(mode)
                self.assertEqual(status, 1); self.assertEqual(calls, 1)
                self.assertFalse(result['passed']); self.assertIsNone(result['artifactBase64'])
                self.assertNotIn('private', output); self.assertNotIn('must-not-escape', output)

    def test_actual_preflight_rejection_shape_never_starts_task(self):
        status, result, calls, _ = self.fixture('auth_rejection')
        self.assertEqual(status, 1); self.assertEqual(calls, 0)
        self.assertTrue(result['authenticationRejected']); self.assertEqual(result['preflightChecks'], 5)
        self.assertEqual(result['modelInvocations'], 0); self.assertFalse(result['taskStarted'])
        self.assertIsNone(result['artifactBase64'])

    def test_preflight_workspace_change_blocks_task_before_query(self):
        status, result, calls, _ = self.fixture('preflight_mutation')
        self.assertEqual(status, 1)
        self.assertEqual(calls, 0)
        self.assertFalse(result['taskStarted'])


if __name__ == '__main__':
    unittest.main()
