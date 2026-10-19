"""Independent candidate validation, including near-limit complete app output."""
import base64
import json
import unittest
import test_teetime_demo_case as demo_case_tests
from teetime_demo_case import MODEL_PATHS
from teetime_demo_result import validate_demo_task_result, validate_demo_task_failure, MAX_DEMO_TASK_RESULT


class DemoResultTests(unittest.TestCase):
    def setUp(self):
        fixture = demo_case_tests.DemoCaseTests()
        fixture.setUp()
        self.prepared = fixture.prepare()
        self.binding = {'runId': 'actual-prepared-run', 'nodeId': 'implement', 'attempt': 1,
            'authorityHash': 'sha256:' + 'a'*64, 'policyHash': 'sha256:' + 'b'*64,
            'baseManifestHash': self.prepared.manifest_hash}
        self.artifact = {'version': 1, 'binding': self.binding, 'operations': [
            {'action': 'write', 'path': path, 'baseHash': None, 'mode': '100644',
             'content': '// app source\n'} for path in MODEL_PATHS if path != 'README.md']}

    def packet(self, artifact=None, **changes):
        raw = json.dumps(artifact or self.artifact, separators=(',', ':')).encode()
        return json.dumps({'kind': 'supervised-demo-v1', 'collected': True,
            'artifactBase64': base64.b64encode(raw).decode(), 'modelInvocations': 1,
            'assistantCount': 1, 'resultCount': 1, 'thinkingCount': 0,
            'normalProviderEnd': True, 'providerIteratorClosed': True,
            'aborted': False, 'servedModelVerified': False, **changes}).encode()

    def validate(self, packet, code=0):
        return validate_demo_task_result(code, packet, prepared=self.prepared,
                                         expected_binding=self.binding)

    def test_complete_near_limit_candidate(self):
        raw = json.dumps(self.artifact, separators=(',', ':')).encode()
        self.artifact['operations'][0]['content'] += 'x'*(65536-len(raw))
        packet = self.packet()
        self.assertLess(len(packet), MAX_DEMO_TASK_RESULT)
        candidate = self.validate(packet)
        self.assertEqual(len(candidate.files), 16)
        self.artifact['operations'][0]['content'] += 'x'
        with self.assertRaises(ValueError): self.validate(self.packet())

    def test_wrong_binding_missing_sources_and_immutable_changes_rejected(self):
        self.artifact['binding'] = {**self.binding, 'runId': 'another-run'}
        with self.assertRaises(ValueError): self.validate(self.packet())
        self.artifact['binding'] = self.binding
        original = self.artifact['operations'].pop()
        with self.assertRaises(ValueError): self.validate(self.packet())
        self.artifact['operations'].append(original)
        self.artifact['operations'][0]['path'] = 'package.json'
        with self.assertRaises(ValueError): self.validate(self.packet())

    def test_bad_completion_encoding_and_duplicate_keys_rejected(self):
        for change in [{'modelInvocations': True}, {'modelInvocations': 2},
                       {'collected': False}, {'aborted': True}, {'normalProviderEnd': False},
                       {'servedModelVerified': True}, {'artifactBase64': 'e30=\n'},
                       {'thinkingCount': 63}, {'unexpected': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.validate(self.packet(**change))
        with self.assertRaises(ValueError): self.validate(self.packet(), 1)
        with self.assertRaises(ValueError):
            self.validate(self.packet().replace(b'"collected": true', b'"collected": true,"collected": true'))

    def test_failed_envelope_has_diagnostics_but_cannot_pass_candidate_validation(self):
        packet=self.packet(collected=False,artifactBase64=None,assistantCount=0,resultCount=0,
            normalProviderEnd=False,providerIteratorClosed=True,
            failureDiagnostic={'stage':'stream','exceptionCategory':'process_hint','lastEvent':'system'})
        parsed=validate_demo_task_failure(1,packet)
        self.assertEqual(parsed['modelInvocations'],1)
        self.assertEqual(parsed['failureDiagnostic']['exceptionCategory'],'process_hint')
        with self.assertRaises(ValueError): self.validate(packet,1)
        with self.assertRaises(ValueError): self.validate(packet,0)
        for code in [0,2,True]:
            with self.subTest(code=code),self.assertRaises(ValueError):validate_demo_task_failure(code,packet)
        with self.assertRaises(ValueError):validate_demo_task_failure(1,self.packet())

    def test_failed_envelope_rejects_drift_extra_duplicate_and_truncated_output(self):
        value=json.loads(self.packet(collected=False,artifactBase64=None,
            failureDiagnostic={'stage':'stream','exceptionCategory':'other','lastEvent':'assistant'}))
        for change in [{'assistantCount':3},{'modelInvocations':True},{'thinkingCount':66},
                       {'unexpected':'private-text'},{'collected':True},{'artifactBase64':'private-data'},
                       {'failureDiagnostic':{'stage':'private-text','exceptionCategory':'other','lastEvent':'none'}},
                       {'failureDiagnostic':None}]:
            with self.subTest(change=change),self.assertRaises(ValueError):
                validate_demo_task_failure(1,json.dumps({**value,**change}).encode())
        raw=json.dumps(value).encode()
        for bad in [raw[:-1],raw+b'x',b'x'*(MAX_DEMO_TASK_RESULT+1),
                    raw.replace(b'"collected": false',b'"collected": false,"collected": false')]:
            with self.assertRaises(ValueError):validate_demo_task_failure(1,bad)

    def test_failure_statistics_reject_contradictory_stage_event_and_closure(self):
        diagnostic={'stage':'stream','exceptionCategory':'other','lastEvent':'assistant'}
        value=json.loads(self.packet(collected=False,artifactBase64=None,failureDiagnostic=diagnostic))
        for change in [{'normalProviderEnd':True,'providerIteratorClosed':False},
                       {'assistantCount':0},
                       {'failureDiagnostic':{**diagnostic,'stage':'policy'}},
                       {'failureDiagnostic':{**diagnostic,'stage':'provider_initialization'}},
                       {'failureDiagnostic':{**diagnostic,'lastEvent':'thinking'}}]:
            with self.subTest(change=change),self.assertRaises(ValueError):
                validate_demo_task_failure(1,json.dumps({**value,**change}).encode())


if __name__ == '__main__': unittest.main()
