"""Strict diagnostic packets cannot become app artifacts or wrapper authority."""
import json
import unittest

from teetime_minimal_diagnostic import validate_minimal_diagnostic


class MinimalDiagnosticTests(unittest.TestCase):
    def success(self):
        return {'version': 1, 'kind': 'teetime-minimal-diagnostic', 'passed': True,
                'responseVerified': True, 'modelInvocations': 1, 'assistantCount': 1,
                'resultCount': 1, 'thinkingCount': 0, 'chunkCount': 2,
                'normalProviderEnd': True, 'providerIteratorClosed': True,
                'aborted': False, 'failure': None}

    def failure(self):
        value = self.success()
        value.update(passed=False, responseVerified=False, assistantCount=0,
                     resultCount=0, chunkCount=0, normalProviderEnd=False,
                     failure={'code': 'provider_exception', 'cleanupFailure': False, 'exceptionCategory': 'auth_hint',
                              'provenance': {'version': 1, 'origin': 'native_turn_failed'}})
        return value

    def parse(self, value, code=0):
        return validate_minimal_diagnostic(code, json.dumps(value).encode('ascii'))

    def test_exact_success_and_failure_are_diagnostic_data_only(self):
        for code, value in [(0, self.success()), (1, self.failure())]:
            self.assertEqual(self.parse(value, code), value)
        for value in [self.success(), self.failure()]:
            self.assertNotIn('artifactBase64', value)

    def test_success_contradictions_and_exit_status_are_rejected(self):
        for changes in [{'passed': False}, {'responseVerified': False}, {'modelInvocations': 0},
                        {'modelInvocations': True}, {'assistantCount': 0}, {'assistantCount': 2},
                        {'resultCount': 0}, {'resultCount': 2}, {'chunkCount': 1},
                        {'normalProviderEnd': False}, {'providerIteratorClosed': False},
                        {'aborted': True}, {'failure': self.failure()['failure']},
                        {'artifactBase64': 'PRIVATE'}, {'servedModelVerified': True}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.parse({**self.success(), **changes})
        for code in [1, -1, 2, True, None]:
            with self.assertRaises(ValueError): self.parse(self.success(), code)
        with self.assertRaises(ValueError): self.parse(self.failure(), 0)

    def test_failure_schema_enums_bounds_and_local_origins_reject(self):
        for changes in [{'passed': True}, {'responseVerified': True}, {'failure': None},
                        {'thinkingCount': -1}, {'chunkCount': 66}, {'assistantCount': 1},
                        {'modelInvocations': 0}, {'normalProviderEnd': True}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.parse({**self.failure(), **changes}, 1)
        for field, bad in [('code', 'PRIVATE'), ('exceptionCategory', 'PRIVATE'),
                           ('privateMessage', 'PRIVATE'), ('cleanupFailure', 1)]:
            value = self.failure(); value['failure'][field] = bad
            with self.assertRaises(ValueError): self.parse(value, 1)
        for provenance in [{'version': True, 'origin': 'native_turn_failed'},
                           {'version': 1, 'origin': 'PRIVATE'},
                           {'version': 1, 'origin': 'unknown', 'cause': 'PRIVATE'}]:
            value = self.failure(); value['failure']['provenance'] = provenance
            with self.assertRaises(ValueError): self.parse(value, 1)
        value = self.failure(); value['failure']['code'] = 'content_rejected'
        with self.assertRaises(ValueError): self.parse(value, 1)
        value = self.failure(); value['failure'].pop('cleanupFailure')
        with self.assertRaises(ValueError): self.parse(value, 1)
        value = self.failure(); value['failure'].update(code='cleanup_failed', cleanupFailure=False)
        with self.assertRaises(ValueError): self.parse(value, 1)

    def test_chunk_limit_and_pre_abort_have_closed_contradiction_checks(self):
        value = self.failure()
        value.update(thinkingCount=64, chunkCount=65,
                     failure={'code': 'chunk_limit', 'cleanupFailure': False, 'exceptionCategory': 'none',
                              'provenance': {'version': 1, 'origin': 'unknown'}})
        self.assertEqual(self.parse(value, 1), value)
        for changes in [{'chunkCount': 64}, {'thinkingCount': 65}, {'resultCount': 1}]:
            with self.assertRaises(ValueError): self.parse({**value, **changes}, 1)
        before = self.failure()
        before.update(modelInvocations=0, aborted=True, providerIteratorClosed=False,
                      failure={'code': 'aborted', 'cleanupFailure': False, 'exceptionCategory': 'none',
                               'provenance': {'version': 1, 'origin': 'unknown'}})
        self.assertEqual(self.parse(before, 1), before)
        with self.assertRaises(ValueError): self.parse({**before, 'aborted': False}, 1)

    def test_raw_bounds_duplicates_constants_types_and_old_packets_reject(self):
        raw = json.dumps(self.success()).encode('ascii')
        for bad in [raw.replace(b'"version": 1', b'"version": 1,"version": 1'),
                    raw.replace(b'"chunkCount": 2', b'"chunkCount": NaN'),
                    b'x'*4097, b'{}\xff', b'[]', b'null', b'{"kind":"supervised-demo-v1"}',
                    b'{"kind":"fixed-artifact-v1"}', b'{"kind":"phase"}']:
            with self.assertRaises(ValueError): validate_minimal_diagnostic(0, bad)
        for field in ['passed', 'responseVerified', 'normalProviderEnd', 'providerIteratorClosed', 'aborted']:
            value = self.success(); value[field] = 1
            with self.assertRaises(ValueError): self.parse(value)


if __name__ == '__main__':
    unittest.main()
