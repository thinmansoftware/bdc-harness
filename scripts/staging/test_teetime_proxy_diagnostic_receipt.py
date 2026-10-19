"""Negative schema and legacy compatibility cases; no sockets or accounts."""
import copy
import json
import unittest
from unittest.mock import patch
import teetime_connect_proxy as proxy
from teetime_proxy_receipt import parse_proxy_receipt
from teetime_proxy_diagnostic_receipt import parse_proxy_diagnostic_receipt


class DiagnosticReceiptTests(unittest.TestCase):
    def setUp(self):
        self.state = patch.multiple(proxy, active=0, process_bytes=0, outcomes={},
                                    parser_reasons={}, non_parser_reasons={}, diagnostic_invalid=False)
        self.state.start(); self.addCleanup(self.state.stop)
        self.value = proxy.build_proxy_receipt(True)

    def packet(self, value=None, ready=None):
        return (json.dumps({'proxyReady': True, 'diagnosticVersion': 1} if ready is None else ready)
                +'\n'+json.dumps(self.value if value is None else value)+'\n').encode('ascii')

    def test_default_output_is_exact_legacy_shape_and_parsers_are_separate(self):
        proxy.outcomes['closed'] = 2; proxy.process_bytes = 42
        legacy = proxy.build_proxy_receipt()
        self.assertEqual(legacy, {'outcomes': {'closed': 2}, 'bytes': 42, 'active': 0})
        raw = b'{"proxyReady":true}\n'+json.dumps(legacy).encode()
        self.assertEqual(parse_proxy_receipt(raw)['closed'], 2)
        with self.assertRaises(ValueError): parse_proxy_diagnostic_receipt(raw)
        with self.assertRaises(ValueError): parse_proxy_receipt(self.packet())

    def test_rejects_missing_extra_unknown_types_and_limits(self):
        cases = []
        for key in self.value:
            value = copy.deepcopy(self.value); del value[key]; cases.append(value)
        for key in ['outcomes', 'parserReasons', 'nonParserReasons']:
            value = copy.deepcopy(self.value); value[key]['PRIVATE'] = 0; cases.append(value)
            value = copy.deepcopy(self.value); value[key].pop(next(iter(value[key]))); cases.append(value)
            for bad in [True, -1, 1.5, 10**9+1, 'PRIVATE', None]:
                value = copy.deepcopy(self.value); value[key][next(iter(value[key]))] = bad; cases.append(value)
        for key, bad in [('version', True), ('version', 2), ('kind', 'PRIVATE'), ('active', 1),
                         ('bytes', True), ('bytes', 64*1024*1024+1)]:
            value = copy.deepcopy(self.value); value[key] = bad; cases.append(value)
        value = copy.deepcopy(self.value); value['PRIVATE'] = 'PRIVATE'; cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_proxy_diagnostic_receipt(self.packet(value))
        for ready in [{'proxyReady': 1, 'diagnosticVersion': 1},
                      {'proxyReady': True, 'diagnosticVersion': True},
                      {'proxyReady': True, 'diagnosticVersion': 1, 'PRIVATE': 0}]:
            with self.assertRaises(ValueError): parse_proxy_diagnostic_receipt(self.packet(ready=ready))

    def test_rejects_accounting_contradictions_in_producer_and_parser(self):
        for key, name in [('outcomes', 'header_or_destination_denied'),
                          ('outcomes', 'rejected_or_closed'), ('outcomes', 'timeout'),
                          ('outcomes', 'dns_denied'), ('parserReasons', 'unsupported_header'),
                          ('nonParserReasons', 'tunnel')]:
            value = copy.deepcopy(self.value); value[key][name] = 1
            with self.assertRaises(ValueError): parse_proxy_diagnostic_receipt(self.packet(value))
        proxy.outcomes['rejected_or_closed'] = 1
        proxy.non_parser_reasons['tunnel'] = 1
        with self.assertRaises(ValueError): proxy.build_proxy_receipt(True)
        proxy.outcomes['closed'] = 1
        self.assertEqual(parse_proxy_diagnostic_receipt(self.packet(proxy.build_proxy_receipt(True)))['outcomes']['closed'], 1)
        proxy.parser_reasons['PRIVATE'] = 0
        with self.assertRaises(ValueError): proxy.build_proxy_receipt(True)

    def test_strict_json_and_ascii_framing(self):
        good = self.packet()
        cases = [b'', b'x'*4097, good+b'\nextra', good.replace(b'"version": 1', b'"version": 1, "version": 1'),
                 good.replace(b'"bytes": 0', b'"bytes": NaN'),
                 good.replace(b'"bytes": 0', b'"bytes": Infinity'),
                 good.replace(b'"closed": 0', b'"closed": 0, "closed": 0'),
                 good.replace(b'teetime-proxy-diagnostic', b'\xff'), b'[]\n[]', good.decode()]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(ValueError): parse_proxy_diagnostic_receipt(raw)


if __name__ == '__main__': unittest.main()
