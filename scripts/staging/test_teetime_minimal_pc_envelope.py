import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import test_teetime_minimal_operator_record as fixtures

spec = importlib.util.spec_from_file_location('future_envelope', Path(__file__).with_name('teetime_minimal_pc_envelope.py'))
envelope = importlib.util.module_from_spec(spec); spec.loader.exec_module(envelope)


class FutureEnvelopeTests(unittest.TestCase):
    def run_fixture(self, *, failed=True, settled=True, malformed=False):
        operator = fixtures.OperatorRecordTests().record('failed' if failed else 'success')
        result = {'exit': 1 if failed else 0, 'out': b'PRIVATE' if malformed else json.dumps(operator).encode('ascii'),
                  'stdoutBytes': 100, 'stderrBytes': 0, 'settled': settled,
                  'failure': None if settled else 'settlement-uncertain'}
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(envelope, 'ROOT', Path(folder)), patch.object(envelope, 'SOURCE', fixtures.fixtures.SOURCE), \
                    patch.object(envelope, 'preflight', return_value=({}, {'head': 'a'*40})), \
                    patch.object(envelope, 'capture', return_value=result), patch.object(sys, 'argv', ['future', 'a'*40]):
                code = envelope.main()
            record = json.loads((Path(folder)/'minimal-pc-launch.result.json').read_bytes())
            self.assertTrue((Path(folder)/'minimal-pc-launch.claim.json').exists())
            self.assertNotIn('PRIVATE', json.dumps(record))
            return code, record

    def test_valid_failed_operator_record_is_retained_without_success_upgrade(self):
        code, record = self.run_fixture()
        self.assertEqual(code, 1); self.assertFalse(record['passed'])
        self.assertEqual(record['failure'], 'operator-failed')
        self.assertTrue(record['operator']['originalAuthUnchanged'])
        self.assertFalse(record['operator']['result']['passed'])
        self.assertFalse(record['remoteCleanupProven'])

    def test_only_clean_success_sets_outer_success(self):
        code, record = self.run_fixture(failed=False)
        self.assertEqual(code, 0); self.assertTrue(record['passed'])

    def test_malformed_or_unsettled_output_is_not_retained(self):
        for options in [{'malformed': True}, {'settled': False}]:
            code, record = self.run_fixture(**options)
            self.assertEqual(code, 1); self.assertNotIn('operator', record)

    def test_cli_is_disabled_before_preflight_or_account_access(self):
        child = subprocess.run([sys.executable, '-I', '-B', str(Path(envelope.__file__)), 'a'*40],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(child.returncode, 2)
        self.assertEqual(json.loads(child.stdout)['failure'], 'source-template-not-admitted')
        self.assertEqual(child.stderr, b'')


if __name__ == '__main__': unittest.main()
