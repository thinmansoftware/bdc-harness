import json
import unittest
from teetime_proxy_receipt import parse_proxy_receipt


class ProxyReceiptTests(unittest.TestCase):
    def test_returns_only_fixed_counters(self):
        raw = b'{"proxyReady":true}\n'+json.dumps({'outcomes':{'timeout':2,'closed':3},'bytes':42,'active':0}).encode()
        result = parse_proxy_receipt(raw)
        self.assertEqual(result['timeout'], 2)
        self.assertEqual(result['bytes'], 42)
        self.assertEqual(result['dns_denied'], 0)

    def test_rejects_extra_text_fields_and_invalid_values(self):
        cases = [
            {'outcomes':{'raw':'synthetic sentinel'},'bytes':1,'active':0},
            {'outcomes':{},'bytes':True,'active':0},
            {'outcomes':{},'bytes':1,'active':1},
            {'outcomes':{},'bytes':-1,'active':0},
        ]
        for data in cases:
            with self.assertRaises(ValueError):
                parse_proxy_receipt(b'{"proxyReady":true}\n'+json.dumps(data).encode())
        for raw in [b'', b'raw diagnostic', b'{"proxyReady":true}\n{}\nextra', b'x'*4097]:
            with self.assertRaises(ValueError):
                parse_proxy_receipt(raw)


if __name__ == '__main__':
    unittest.main()
