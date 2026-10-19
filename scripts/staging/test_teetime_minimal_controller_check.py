"""Independent minimal controller checks; all external observations mocked."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from teetime_artifact_contract import canonical
import test_teetime_minimal_execution as executions
import test_teetime_minimal_protocol as protocols
import teetime_minimal_controller_check as checks


class MinimalControllerCheckTests(unittest.TestCase):
    def setUp(self):
        protocol=protocols.MinimalProtocolTests();protocol.setUp()
        fixture=executions.MinimalExecutionTests();fixture.setUp()
        fixture.value.update(image=protocol.ready['image'],source=protocol.ready['diagnosticSourceSha'],
            baseSource=protocol.ready['sourceSha'],selectedHashes=protocol.hashes,
            providerPolicyHash='sha256:'+protocol.hashes['packages/providers/src/codex/restricted-policy.ts'])
        self.raw=canonical(fixture.value).encode('ascii');self.execution=fixture.parse()
        self.hashes=protocol.hashes;self.ready=protocol.ready;self.report=protocol.report

    def invoke(self,mode,value=None):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'minimal-execution.json').write_bytes(self.raw)
            with patch('teetime_minimal_controller_check.diagnostic_hashes',return_value=self.hashes):
                return checks.check(root,self.execution.package_hash,mode,
                    canonical(value).encode('ascii') if value is not None else b'')

    def test_metadata_and_separate_validated_receipt_have_no_product_fields(self):
        value=self.invoke('metadata')
        self.assertEqual(value['runId'],self.execution.run_id)
        self.assertEqual(len(value['predecessors']),4)
        self.assertNotIn('prompt',value);self.assertNotIn('binding',value)
        self.assertEqual(self.invoke('ready',self.ready),{'readyVerified':True})
        summary=self.invoke('report',{'ready':self.ready,'report':self.report,'exitCode':0})
        self.assertTrue(summary['passed']);self.assertEqual(summary['modelInvocations'],1)
        self.assertNotIn('artifactHash',summary)

    def test_unavailable_task_evidence_is_unknown_and_outer_failure_remains_failure(self):
        report=copy.deepcopy(self.report)
        report['result'].update(passed=False,workerExitCode=None,workerResult=None)
        value=self.invoke('report',{'ready':self.ready,'report':report,'exitCode':1})
        self.assertFalse(value['passed']);self.assertIsNone(value['modelInvocations'])

    def test_changed_packet_hash_selected_source_or_receipt_reject(self):
        original=self.raw;self.raw+=b' '
        with self.assertRaises(ValueError):self.invoke('metadata')
        self.raw=original
        for kind in ['hashes','exit','nonce','cleanup','extra']:
            value={'ready':copy.deepcopy(self.ready),'report':copy.deepcopy(self.report),'exitCode':0}
            original_hashes=self.hashes
            if kind=='hashes':self.hashes={**self.hashes,next(iter(self.hashes)):'f'*64}
            if kind=='exit':value['exitCode']=1
            if kind=='nonce':value['report']['nonce']='f'*32
            if kind=='cleanup':value['report']['result']['cleanupVerified']=False
            if kind=='extra':value['unexpected']='PRIVATE'
            try:
                with self.subTest(kind=kind),self.assertRaises(ValueError):self.invoke('report',value)
            finally:self.hashes=original_hashes

    def test_predecessor_routes_only_parsed_minimal_packet_to_bounded_adapter(self):
        with patch('teetime_successor_observation.observe_minimal_local',return_value={'resourcesAbsent':True}) as observed:
            self.assertEqual(self.invoke('predecessor'),{'resourcesAbsent':True})
            self.assertEqual(observed.call_args.args[1],self.execution)


if __name__=='__main__':unittest.main()
