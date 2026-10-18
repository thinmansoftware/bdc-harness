"""Synthetic framing only; does not launch SDK or model requests."""
import json
import unittest

from teetime_fixture_diagnostics import DiagnosticProtocol, ImportDiagnosticProtocol, PHASES


def record(value):
    return json.dumps(value, separators=(',', ':')).encode()+b'\n'


def final(phase='complete'):
    return {'kind': 'result', 'accepted': False, 'bytesBase64': None, 'intercepted': 0, 'threads': 0,
        'optionsVerified': False, 'threadOptionsVerified': False, 'importIntercepted': False,
        'normalProviderEnd': False, 'counts': {}, 'abortedBeforeCleanup': True, 'phase': phase,
        'errorName': 'Error', 'errorCode': None}


class DiagnosticTests(unittest.TestCase):
    def test_fragmented_records_and_exact_final(self):
        protocol = DiagnosticProtocol()
        raw = b''.join(record({'kind': 'phase', 'phase': phase}) for phase in PHASES)+record(final())
        for byte in raw:
            protocol.feed(bytes([byte]))
        self.assertEqual(protocol.last_phase, 'complete')
        self.assertEqual(protocol.finish(0)['phase'], 'complete')

    def test_phase_is_never_a_final(self):
        protocol = DiagnosticProtocol()
        protocol.feed(record({'kind': 'phase', 'phase': 'logger'}))
        with self.assertRaises(ValueError):
            protocol.finish(0)

    def test_unknown_keys_duplicate_json_and_invalid_order(self):
        for raw in [record({'kind': 'phase', 'phase': 'secret'}),
                    record({'kind': 'phase', 'phase': 'resolve'}),
                    record({'kind': 'phase', 'phase': 'logger', 'extra': 1}),
                    b'{"kind":"phase","phase":"logger","phase":"logger"}\n',
                    b'not-json\n', b'\xff\n', record([])]:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    DiagnosticProtocol().feed(raw)

    def test_duplicate_phase_final_and_post_final_data(self):
        for tail in [record({'kind': 'phase', 'phase': 'logger'}), record(final('logger')),
                     record({'kind': 'phase', 'phase': 'resolve'})]:
            protocol = DiagnosticProtocol()
            protocol.feed(record({'kind': 'phase', 'phase': 'logger'}))
            if tail != record({'kind': 'phase', 'phase': 'logger'}):
                protocol.feed(record(final('logger')))
            with self.assertRaises(ValueError):
                protocol.feed(tail)

    def test_partial_failure_retains_only_last_validated_phase(self):
        protocol = DiagnosticProtocol()
        protocol.feed(record({'kind': 'phase', 'phase': 'logger'}))
        protocol.feed(b'{"kind":"pha')
        with self.assertRaises(ValueError):
            protocol.finish(0)
        self.assertEqual(protocol.last_phase, 'logger')

    def test_final_schema_and_allowlisted_error_categories(self):
        for key, value in [('errorName', 'raw-message'), ('errorCode', 'private'),
                           ('threads', True), ('accepted', 1), ('counts', {'private': 1}),
                           ('phase', 'complete'), ('bytesBase64', 'bad'), ('extra', 1)]:
            protocol = DiagnosticProtocol()
            protocol.feed(record({'kind': 'phase', 'phase': 'logger'}))
            changed = {**final('logger'), key: value}
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    protocol.feed(record(changed))

    def test_protocol_bound(self):
        with self.assertRaises(ValueError):
            DiagnosticProtocol().feed(b'x'*32769)
        with self.assertRaises(ValueError):
            DiagnosticProtocol().feed('text')

    def test_valid_final_cannot_salvage_nonzero_or_unknown_process_exit(self):
        protocol = DiagnosticProtocol()
        protocol.feed(record({'kind': 'phase', 'phase': 'logger'})+record(final('logger')))
        for code in [1, -9, None, True]:
            with self.subTest(code=code):
                with self.assertRaises(ValueError):
                    protocol.finish(code)

    def test_accepted_result_rejects_contradictory_completion_fields(self):
        success = {**final(), 'accepted': True, 'bytesBase64': 'AA==',
                   'normalProviderEnd': True, 'abortedBeforeCleanup': False, 'errorName': None}
        for key, value in [('errorName', 'Error'), ('errorCode', 'MODULE_NOT_FOUND'),
                           ('normalProviderEnd', False), ('abortedBeforeCleanup', True),
                           ('phase', 'collect')]:
            protocol = DiagnosticProtocol()
            phases = PHASES[:-1] if key == 'phase' else PHASES
            for phase in phases:
                protocol.feed(record({'kind': 'phase', 'phase': phase}))
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    protocol.feed(record({**success, key: value}))

    def test_import_only_marker_has_separate_schema_and_no_artifact_authority(self):
        protocol = ImportDiagnosticProtocol()
        for phase in PHASES[:7]:
            protocol.feed(record({'kind': 'phase', 'phase': phase}))
        value = {'kind': 'import-only-result', 'phase': 'factory-import', 'importOnlySuccess': True,
                 'exportsVerified': True, 'moduleIntercepted': True, 'factoryImported': True,
                 'errorName': None, 'errorCode': None}
        protocol.feed(record(value))
        self.assertEqual(protocol.finish(0), value)
        self.assertNotIn('accepted', protocol.final)
        other = ImportDiagnosticProtocol()
        other.feed(record({'kind': 'phase', 'phase': 'logger'}))
        with self.assertRaises(ValueError):
            other.feed(record(final('logger')))

    def test_import_only_success_rejects_incomplete_or_failed_initialization(self):
        value = {'kind': 'import-only-result', 'phase': 'factory-import', 'importOnlySuccess': True,
                 'exportsVerified': True, 'moduleIntercepted': True, 'factoryImported': True,
                 'errorName': None, 'errorCode': None}
        for key, changed in [('exportsVerified', False), ('moduleIntercepted', False),
                             ('factoryImported', False), ('errorName', 'Error'), ('extra', 1)]:
            protocol = ImportDiagnosticProtocol()
            for phase in PHASES[:7]:
                protocol.feed(record({'kind': 'phase', 'phase': phase}))
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    protocol.feed(record({**value, key: changed}))


if __name__ == '__main__':
    unittest.main()
