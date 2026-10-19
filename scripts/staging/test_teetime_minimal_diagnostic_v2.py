import json
import unittest
import test_teetime_minimal_diagnostic as legacy
from teetime_minimal_diagnostic import validate_minimal_diagnostic, validate_minimal_diagnostic_v2


class MinimalV2Tests(unittest.TestCase):
    def packet(self):
        value = legacy.MinimalDiagnosticTests().failure()
        value['version'] = 2
        value['failure']['provenance']['origin'] = 'sdk_iterator_exception'
        value['failure']['sdkEvidence'] = {'version': 1, 'kind': 'cli-exit', 'exitCode': 1,
            'signal': None, 'stderrCategory': 'config-load', 'startupEvidence': {
                'stderrBytes': 80, 'classificationLimited': False,
                'startupStages': ['config-load'], 'causeCategories': ['os-error'], 'osErrnos': [13]}}
        return value

    def parse(self, value):
        return validate_minimal_diagnostic_v2(1, json.dumps(value).encode('ascii'))

    def test_exact_and_unknown_sdk_details(self):
        value = self.packet()
        self.assertEqual(self.parse(value), value)
        value['failure']['sdkEvidence'] = {'version': 1, 'kind': 'other', 'exitCode': None,
            'signal': None, 'stderrCategory': 'other', 'startupEvidence': None}
        self.assertEqual(self.parse(value), value)

    def test_closed_kinds_and_primary_origin_reject_contradictions(self):
        for changes in [{'exitCode': True}, {'exitCode': 256}, {'signal': 'SIGKILL'},
                        {'signal': 'PRIVATE', 'exitCode': None}, {'startupEvidence': None},
                        {'kind': 'sdk-parse'}, {'stderrCategory': 'other'}, {'extra': 'PRIVATE'}]:
            value = self.packet(); value['failure']['sdkEvidence'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.parse(value)
        for origin, evidence in [('unknown', self.packet()['failure']['sdkEvidence']), ('sdk_iterator_exception', None)]:
            value = self.packet(); value['failure']['provenance']['origin'] = origin
            value['failure']['sdkEvidence'] = evidence
            with self.assertRaises(ValueError): self.parse(value)

    def test_startup_order_bounds_and_counters_reject(self):
        for changes in [{'classificationLimited': True}, {'stderrBytes': True},
                        {'stderrBytes': -1}, {'stderrBytes': 10**9+1},
                        {'startupStages': ['config-load', 'config-load']}, {'startupStages': ['PRIVATE']},
                        {'startupStages': ['exec-policy', 'config-overrides']},
                        {'osErrnos': [30, 13]}, {'osErrnos': [True]}, {'osErrnos': [14]},
                        {'causeCategories': ['other']}, {'causeCategories': ['os-error', 'os-error']}]:
            value = self.packet(); value['failure']['sdkEvidence']['startupEvidence'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError): self.parse(value)

    def test_versions_and_missing_detail_are_not_normalized(self):
        for mutate in ['version', 'missing', 'legacy']:
            value = self.packet()
            if mutate == 'version': value['version'] = 1
            elif mutate == 'missing': value['failure'].pop('sdkEvidence')
            else: value = legacy.MinimalDiagnosticTests().failure()
            with self.assertRaises(ValueError): self.parse(value)

    def test_historical_sdk_failure_stays_v1_without_invented_detail(self):
        value = legacy.MinimalDiagnosticTests().failure()
        value['failure']['exceptionCategory'] = 'other'
        value['failure']['provenance']['origin'] = 'sdk_iterator_exception'
        raw = json.dumps(value).encode('ascii')
        parsed = validate_minimal_diagnostic(1, raw)
        self.assertEqual(parsed, value)
        self.assertNotIn('sdkEvidence', parsed['failure'])
        self.assertEqual(parsed['version'], 1)
        with self.assertRaises(ValueError): validate_minimal_diagnostic_v2(1, raw)


if __name__ == '__main__': unittest.main()
