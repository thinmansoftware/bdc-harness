import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from teetime_artifact_contract import canonical
from teetime_demo_case import MODEL_PATHS, parse_demo_artifact
from teetime_demo_controller_check import check
import test_teetime_demo_execution as execution_tests
import test_teetime_auth_artifact_protocol as protocol_tests


class ControllerCheckTests(unittest.TestCase):
    def setUp(self):
        fixture = execution_tests.DemoExecutionTests(); fixture.setUp()
        self.raw = canonical(fixture.value).encode()
        self.execution = fixture.parse()
        protocol = protocol_tests.ArtifactProtocolTests(); protocol.setUp()
        self.hashes = {**protocol.hashes, 'packages/providers/src/codex/restricted-policy.ts': 'b'*64}
        self.ready = {**protocol.ready, 'task': 'supervised-demo',
                      'artifactContractHash': self.execution.package_hash,
                      'image': self.execution.image, 'sourceSha': self.execution.base_source,
                      'artifactSourceSha': self.execution.source, 'hashes': self.hashes}
        artifact = canonical({'version': 1, 'binding': dict(self.execution.binding),
            'operations': [{'action': 'write', 'path': name, 'mode': '100644',
                            'baseHash': None, 'content': '// simulated app fixture\n'}
                           for name in MODEL_PATHS if name != 'README.md']}).encode()
        candidate = parse_demo_artifact(artifact, prepared=self.execution.prepared,
                                        expected_binding=dict(self.execution.binding))
        worker = protocol.worker()
        worker['workspaceDiagnostic']={'category':'unchanged','entryCount':2,'maskEntryCount':0}
        worker.update({'artifactBase64': base64.b64encode(artifact).decode(),
                       'artifactHash': candidate.artifact_hash, 'bindingHash': candidate.binding_hash,
                       'manifestHash': candidate.manifest_hash, 'sourceTree': candidate.source_tree})
        self.packet = {'ready': self.ready, 'exitCode': 0, 'report': {
            'type': 'RESULT', 'nonce': self.ready['nonce'], 'owner': self.ready['owner'],
            'task': 'supervised-demo', 'artifactSourceSha': self.execution.source,
            'artifactContractHash': self.execution.package_hash, 'receiptDirectory': 'owned-fixture',
            'cleanupErrors': [], 'proxyMetrics': {'bytes': 1, 'header_or_destination_denied': 0,
                'dns_denied': 0, 'byte_limit': 0, 'timeout': 0, 'rejected_or_closed': 0, 'closed': 1},
            'result': {'passed': True, 'cleanupVerified': True, 'credentialReceived': True,
                       'proxyMetricsVerified': True, 'artifactResult': worker}}}

    def invoke(self, mode, value=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'demo-execution.json').write_bytes(self.raw)
            with patch('teetime_demo_controller_check.artifact_hashes', return_value=self.hashes):
                return check(root, self.execution.package_hash, mode,
                             canonical(value).encode() if value is not None else b'')

    def test_actual_parser_reconstructs_candidate_and_checks_complete_cleanup(self):
        self.assertEqual(self.invoke('metadata')['binding']['runId'], 'actual-run')
        self.assertEqual(self.invoke('ready', self.ready), {'readyVerified': True})
        self.assertTrue(self.invoke('report', self.packet)['candidateVerified'])
        for change in ['cleanup', 'exit', 'auth', 'artifact', 'package']:
            value = copy.deepcopy(self.packet)
            if change == 'cleanup': value['report']['result']['cleanupVerified'] = False
            elif change == 'exit': value['exitCode'] = 1
            elif change == 'auth': value['report']['result']['artifactResult']['authUnchanged'] = False
            elif change == 'artifact': value['report']['result']['artifactResult']['artifactHash'] = '0'*64
            else: value['report']['artifactContractHash'] = '0'*64
            with self.subTest(change=change), self.assertRaises(ValueError): self.invoke('report', value)

    def test_package_bytes_cannot_change_under_the_same_hash(self):
        self.raw += b' '
        with self.assertRaises(ValueError): self.invoke('metadata')

    def test_successor_metadata_and_live_observer_are_bound_to_package(self):
        with self.assertRaises(ValueError): self.invoke('predecessor')
        fixture = execution_tests.DemoExecutionTests(); fixture.setUp()
        fixture.value.update(version=2, kind='supervised-demo-v2')
        fixture.value['binding']['attempt'] = 2
        fixture.value['predecessor'] = {
            'attemptId':'ec3fd06e-5f27-4eda-9af1-2f759e4157ae',
            'completedAt':'2026-10-19T02:43:09.062Z', 'owner':'teetime-auth-5eca42816a98',
            **{key:'sha256:'+'1'*64 for key in
               ['rowHash','executionHash','resultHash','claimHash','manifestHash','lockHash']}}
        self.raw = canonical(fixture.value).encode()
        self.execution = fixture.parse()
        self.assertEqual(self.invoke('metadata')['predecessor'],fixture.value['predecessor'])
        with patch('teetime_successor_observation.observe_local',return_value={'fixture':True}) as observed:
            self.assertEqual(self.invoke('predecessor'),{'fixture':True})
            self.assertEqual(observed.call_args.args[1],fixture.value['predecessor'])
            self.assertEqual(observed.call_args.args[2],'actual-run')


if __name__ == '__main__': unittest.main()
