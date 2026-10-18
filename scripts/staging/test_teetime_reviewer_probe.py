import json
import unittest
from types import SimpleNamespace
from teetime_reviewer_probe import reviewer_settings, verify_reviewer_limits, remove_owned_reviewer, reviewer_failure_diagnostic


OWNER = 'teetime-reviewer-123-1'
NAME = 'teetime-sandbox-probe-' + 'a'*12
ID = 'b'*64


class ReviewerProbeTests(unittest.TestCase):
    def test_failure_diagnostic_never_satisfies_success_or_zero_exit(self):
        frame={'kind':'teetime-reviewer-failure-v1','phase':'catalog-compare','category':'catalog-identity'}
        raw=json.dumps(frame).encode()+b'\n'
        self.assertEqual(reviewer_failure_diagnostic(raw,1),frame)
        for code in (0,None,True):
            with self.assertRaises(ValueError): reviewer_failure_diagnostic(raw,code)
        with self.assertRaises(ValueError):
            reviewer_failure_diagnostic(b'{"passed":true,"modelInvocations":0}\n',1)

    def test_malformed_or_extra_failure_diagnostics_rejected(self):
        frame={'kind':'teetime-reviewer-failure-v1','phase':'catalog-compare','category':'catalog-identity'}
        for changed in [{**frame,'extra':'secret'},{**frame,'phase':'unknown'},
                        {**frame,'category':'raw error text'}]:
            with self.assertRaises(ValueError):
                reviewer_failure_diagnostic(json.dumps(changed).encode(),1)
        raw=json.dumps(frame).encode()+b'\n'
        for changed in [raw+raw,b'not json',raw+b'\nextra',b'x'*2049,
                        raw.replace(b'"phase":',b'"phase":"sdk-run","phase":')]:
            with self.assertRaises(ValueError): reviewer_failure_diagnostic(changed,1)

    def test_closed_cases_owner_and_resource_limits(self):
        for case in ('positive', 'shell', 'patch', 'code-mode'):
            settings = reviewer_settings(case, OWNER)
            self.assertIn('teetime.reviewer-fixture='+OWNER, settings)
            self.assertIn('teetime.reviewer-case='+case, settings)
            self.assertIn('128', settings)
            self.assertIn('768m', settings)
        for case, owner in [('other', OWNER), ('positive', ''), ('positive', 'prod')]:
            with self.assertRaises(ValueError):
                reviewer_settings(case, owner)

    def test_exact_runtime_limits_required(self):
        host = {'PidsLimit':128, 'Memory':805306368, 'MemorySwap':805306368, 'NanoCpus':1000000000}
        verify_reviewer_limits(host)
        for key in host:
            changed = {**host, key:0}
            with self.assertRaises(ValueError):
                verify_reviewer_limits(changed)

    def test_cleanup_removes_only_inspected_owned_id_then_checks_absence(self):
        calls = []
        def docker(*parts, **_):
            calls.append(parts)
            if parts[:3] == ('container','ls','-aq'):
                self.assertIn('--no-trunc', parts)
            if parts[0] == 'inspect':
                return SimpleNamespace(returncode=0, stdout=json.dumps([{
                    'Id':ID, 'Name':'/'+NAME, 'Config':{'Labels':{'teetime.reviewer-fixture':OWNER}}
                }]))
            if parts[:3] == ('container','ls','-aq'):
                return SimpleNamespace(returncode=0, stdout=ID if len(calls)==1 else '')
            return SimpleNamespace(returncode=0, stdout='')
        remove_owned_reviewer(docker, NAME, OWNER)
        self.assertIn(('rm','-f',ID), calls)
        self.assertNotIn(('rm','-f',NAME), calls)

    def test_foreign_owner_and_unverified_removal_fail_closed(self):
        calls = []
        def docker(*parts, **_):
            calls.append(parts)
            if parts[0] == 'inspect':
                return SimpleNamespace(returncode=0, stdout=json.dumps([{
                    'Id':ID,'Name':'/'+NAME,'Config':{'Labels':{'teetime.reviewer-fixture':'other'}}
                }]))
            return SimpleNamespace(returncode=0, stdout=ID)
        with self.assertRaises(ValueError):
            remove_owned_reviewer(docker, NAME, OWNER)
        self.assertFalse(any(call[0]=='rm' for call in calls))

    def test_cleanup_nonabsence_is_failure(self):
        def docker(*parts, **_):
            if parts[0]=='inspect':
                return SimpleNamespace(returncode=0, stdout=json.dumps([{
                    'Id':ID,'Name':'/'+NAME,'Config':{'Labels':{'teetime.reviewer-fixture':OWNER}}
                }]))
            return SimpleNamespace(returncode=0, stdout=ID)
        with self.assertRaises(RuntimeError):
            remove_owned_reviewer(docker, NAME, OWNER)


if __name__ == '__main__':
    unittest.main()
