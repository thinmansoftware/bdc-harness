"""Pure task-result validation is separate from actual wrapper custody observations."""
import base64
import copy
import json
import unittest

from teetime_fixed_artifact import expected_artifact, validate_task_result, validate_wrapper_evidence


class FixedArtifactTests(unittest.TestCase):
    def setUp(self):
        self.nonce = 'a'*32
        self.policy = 'b'*64
        self.raw = expected_artifact(self.nonce, self.policy)
        self.packet = {'kind': 'fixed-artifact-v1', 'passed': True,
            'artifactBase64': base64.b64encode(self.raw).decode(), 'modelInvocations': 1,
            'assistantCount': 1, 'resultCount': 1, 'thinkingCount': 0,
            'normalProviderEnd': True, 'providerIteratorClosed': True, 'aborted': False,
            'failureCategory': 'none', 'servedModelVerified': False}

    def validate(self, code=0, raw=None):
        return validate_task_result(code, json.dumps(self.packet).encode() if raw is None else raw,
                                    nonce=self.nonce, policy_hash=self.policy)

    def test_independent_expected_artifact_and_strict_candidate(self):
        candidate = self.validate()
        self.assertEqual([f.path for f in candidate.files], ['data.bin', 'index.html', 'src/run.sh'])
        self.assertEqual(candidate.files[0].content, b'\0\xffbinary')
        self.assertEqual(candidate.files[2].git_mode, '100755')
        self.assertFalse(self.raw.endswith(b'\n'))
        parsed = json.loads(self.raw)
        self.assertEqual(parsed['binding']['runId'], 'teetime-artifact-'+self.nonce)

    def test_process_failure_or_bad_completion_not_salvaged(self):
        for code in [1, -9, True, None]:
            with self.assertRaises(ValueError):
                self.validate(code)
        original = copy.deepcopy(self.packet)
        for key, value in [('passed', False), ('normalProviderEnd', False), ('providerIteratorClosed', False),
            ('aborted', True), ('modelInvocations', True), ('assistantCount', 2), ('resultCount', 0),
            ('servedModelVerified', True), ('failureCategory', 'other'), ('thinkingCount', 65), ('extra', 1)]:
            self.packet = {**original, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()

    def test_noncanonical_or_foreign_artifact_and_duplicate_packet_fields(self):
        for artifact in [self.raw+b'\n', json.dumps(json.loads(self.raw), indent=2).encode(),
            self.raw.replace(self.nonce.encode(), b'c'*32), self.raw.replace(b'synthetic-artifact-ready', b'changed'),
            self.raw.replace(b'"version":1', b'"version":1,"version":1')]:
            self.packet['artifactBase64'] = base64.b64encode(artifact).decode()
            with self.assertRaises(ValueError):
                self.validate()
        encoded = json.dumps(self.packet).encode().replace(b'"kind":', b'"kind":"duplicate","kind":')
        with self.assertRaises(ValueError):
            self.validate(raw=encoded)
        with self.assertRaises(ValueError):
            self.validate(raw=b'x'*4097)

    def test_invalid_binding_prevents_expected_artifact_construction(self):
        for nonce, policy in [('a'*31, self.policy), (self.nonce, 'B'*64), (None, self.policy)]:
            with self.assertRaises(ValueError):
                expected_artifact(nonce, policy)

    def test_actual_auth_and_workspace_observations_are_separate_from_task(self):
        candidate = self.validate()
        self.assertIsNone(validate_wrapper_evidence(auth_before=b'private-auth', auth_after=b'private-auth',
                                                  workspace_unchanged=True, preflight_checks=6))
        for changed in [{'auth_after': b'changed'}, {'workspace_unchanged': False},
                        {'workspace_unchanged': 1}, {'preflight_checks': 5}, {'preflight_checks': True},
                        {'auth_before': b'', 'auth_after': b''}]:
            args = {'auth_before': b'private-auth', 'auth_after': b'private-auth',
                    'workspace_unchanged': True, 'preflight_checks': 6, **changed}
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_wrapper_evidence(**args)
        self.assertIsNotNone(candidate)


if __name__ == '__main__':
    unittest.main()
