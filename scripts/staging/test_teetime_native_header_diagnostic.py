import json
import unittest
from teetime_connect_proxy import parse_connect, ConnectPolicyError
from teetime_native_header_diagnostic import classify_native_connect


class NativeHeaderDiagnosticTests(unittest.TestCase):
    def test_fixed_classes_ignore_casing_and_values(self):
        for name, category in [('Proxy-Authorization','proxy_authorization'),
                               ('Authorization','authorization'),('ACCEPT','accept'),
                               ('private-marker-name','other')]:
            for value in ['private-marker-value','', 'Bearer private-marker-value']:
                packet=('CONNECT chatgpt.com:443 HTTP/1.1\r\n'+name+': '+value+'\r\n\r\n').encode()
                result=classify_native_connect(packet)
                self.assertEqual(result,{'reason':'unsupported_header','unsupportedHeaders':{category:1}})
                self.assertNotIn('private-marker',json.dumps(result))
                with self.assertRaises(ConnectPolicyError):
                    parse_connect(packet)

    def test_multiple_unsupported_classes_are_bounded_not_arbitrarily_selected(self):
        packet=(b'CONNECT chatgpt.com:443 HTTP/1.1\r\nUser-Agent: private-marker\r\n'
                b'Authorization: private-marker\r\n'+b'Unknown: private-marker\r\n'*40+b'\r\n')
        self.assertEqual(classify_native_connect(packet),{'reason':'unsupported_header',
            'unsupportedHeaders':{'authorization':1,'other':32}})

    def test_existing_failures_are_not_reclassified(self):
        for packet, reason in [
            (b'CONNECT other.invalid:443 HTTP/1.1\r\n\r\n','request_line_or_destination'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: wrong\r\nUser-Agent: x\r\n\r\n','invalid_header_value'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nHost: chatgpt.com:443\r\n\r\n','duplicate_header'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\nbroken\r\n\r\n','encoding_or_framing'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\xff\r\n\r\n','encoding_or_framing'),
        ]:
            self.assertEqual(classify_native_connect(packet),{'reason':reason,'unsupportedHeaders':{}})

    def test_accepted_requests_still_have_no_unsupported_classification(self):
        for headers in ['', 'Host: chatgpt.com:443\r\n', 'Proxy-Connection: Keep-Alive\r\n',
                        'User-Agent: codex_cli_rs/0.153.3 (Linux; x86_64)\r\n']:
            packet=('CONNECT chatgpt.com:443 HTTP/1.1\r\n'+headers+'\r\n').encode()
            self.assertEqual(parse_connect(packet),'chatgpt.com')
            self.assertEqual(classify_native_connect(packet),{'reason':'policy_accepted_mock_rejected',
                'unsupportedHeaders':{}})


if __name__=='__main__':
    unittest.main()
