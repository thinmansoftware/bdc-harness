import ast
from collections import Counter
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import asyncio
import teetime_connect_proxy as proxy
from teetime_proxy_diagnostic_receipt import parse_proxy_diagnostic_receipt, parse_proxy_diagnostic_receipt_v2


def frozen_parser():
    # Exact pre-change Git source at322864a0867579500d94f412f0925c02eb8ae9a2.
    raw = Path(__file__).with_name('fixtures').joinpath('teetime-connect-proxy-v1-source.txt').read_bytes()
    if hashlib.sha256(raw).hexdigest() != 'a3af44e84144bcbd1c49f7a96778199f4c9b2184daea439603f288db8c963e29':
        raise ValueError('frozen baseline bytes differ')
    tree = ast.parse(raw)
    nodes = [node for node in tree.body if
        (isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in ['ConnectPolicyError', 'parse_connect'])
        or (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in
            ['HEADER_LIMIT', 'DENIAL_REASONS'] for target in node.targets))]
    namespace = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<frozen-parser-only>', 'exec'), namespace)
    return namespace['parse_connect']


def outcome(parser, data):
    try: return ('accepted', parser(data))
    except ValueError as error: return ('denied', error.reason)


class ProxyV2Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        state = patch.multiple(proxy, outcomes=Counter(), parser_reasons=Counter(),
            non_parser_reasons=Counter(), request_line_reasons=Counter(),
            process_bytes=0, active=0, diagnostic_invalid=False)
        state.start(); self.addCleanup(state.stop)

    def packet(self, value=None, version=2):
        return (json.dumps({'proxyReady': True, 'diagnosticVersion': version})+'\n'
            +json.dumps(proxy.build_proxy_receipt_v2() if value is None else value)+'\n').encode('ascii')

    def test_first_failed_structural_check_and_frozen_acceptance(self):
        old = frozen_parser()
        cases = [
            (b'GET PRIVATE.invalid HTTP/9\r\n\r\n', 'method'),
            (b'CONNECT PRIVATE.invalid HTTP/9\r\n\r\n', 'http_version'),
            (b'CONNECT PRIVATE.invalid HTTP/1.1\r\n\r\n', 'authority'),
            (b'CONNECT  chatgpt.com:443 HTTP/1.1\r\n\r\n', 'framing'),
            (b'CONNECT\tchatgpt.com:443 HTTP/1.1\r\n\r\n', 'framing'),
            (b'CONNECT chatgpt.com:443\r\n\r\n', 'framing'),
            (b'CONNECT chatgpt.com:443 HTTP/1.1 extra\r\n\r\n', 'framing'),
            (b'CONNECT chatgpt.com:443 http/1.1\r\n\r\n', 'http_version'),
        ]
        for data, reason in cases:
            self.assertEqual(outcome(proxy.parse_connect, data), outcome(old, data))
            with self.assertRaises(proxy.ConnectPolicyError) as caught: proxy.parse_connect(data)
            self.assertEqual(caught.exception.reason, 'request_line_or_destination')
            self.assertEqual(caught.exception.request_line_reason, reason)
            self.assertNotIn('PRIVATE', str(caught.exception))
        corpus = [b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n',
            b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n',
            b'CONNECT chatgpt.com:443 HTTP/1.1\r\nUser-Agent: fixture\r\n\r\n',
            b'CONNECT chatgpt.com:443 HTTP/1.1\r\nUser-Agent: x\r\nuser-agent: y\r\n\r\n',
            b'CONNECT chatgpt.com:443 HTTP/1.1\r\nAuthorization: PRIVATE\r\n\r\n',
            b'CONNECT chatgpt.com:443 HTTP/1.1\n\n',
            b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n\r\n', b'x'*4097, b'\xff\r\n\r\n']
        for data in corpus: self.assertEqual(outcome(proxy.parse_connect, data), outcome(old, data))
        self.assertEqual(proxy.request_line_reasons, Counter())

    async def reject(self, data):
        server = await asyncio.start_server(proxy.handle_client, '127.0.0.1', 0)
        try:
            reader, writer = await asyncio.open_connection('127.0.0.1', server.sockets[0].getsockname()[1])
            writer.write(data); await writer.drain()
            self.assertIn(b'403 Forbidden', await asyncio.wait_for(reader.read(), 3))
            writer.close(); await writer.wait_closed()
        finally: server.close(); await server.wait_closed()

    async def test_handler_counts_one_category_and_unknown_metadata_is_neutral(self):
        await self.reject(b'GET PRIVATE.invalid HTTP/1.1\r\n\r\n')
        with patch.object(proxy, 'parse_connect', side_effect=proxy.ConnectPolicyError('request_line_or_destination')):
            await self.reject(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n')
        for metadata in ['missing', ['PRIVATE']]:
            error = proxy.ConnectPolicyError('request_line_or_destination')
            if metadata == 'missing': del error.request_line_reason
            else: error.request_line_reason = metadata
            with patch.object(proxy, 'parse_connect', side_effect=error):
                await self.reject(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n')
        await self.reject(b'CONNECT chatgpt.com:443 HTTP/1.1\r\nX-PRIVATE: x\r\n\r\n')
        value = parse_proxy_diagnostic_receipt_v2(self.packet())
        self.assertEqual(value['requestLineReasons'], {'authority': 0, 'framing': 0,
            'http_version': 0, 'method': 1, 'unknown': 3})
        self.assertEqual(value['parserReasons']['request_line_or_destination'], 4)
        self.assertEqual(value['parserReasons']['unsupported_header'], 1)
        self.assertNotIn('PRIVATE', json.dumps(value))
        one = proxy.build_proxy_receipt(True)
        self.assertEqual(one['version'], 1); self.assertNotIn('requestLineReasons', one)
        self.assertEqual(parse_proxy_diagnostic_receipt(self.packet(one, 1)), one)
        with self.assertRaises(ValueError): parse_proxy_diagnostic_receipt(self.packet())
        with self.assertRaises(ValueError): parse_proxy_diagnostic_receipt_v2(self.packet(one, 1))

    def test_closed_category_counts_and_totals_fail(self):
        original = proxy.build_proxy_receipt_v2()
        for changes in [{'method': True}, {'method': -1}, {'method': 1}, {'method': 10**9+1}, {'PRIVATE': 0}]:
            value = copy.deepcopy(original); value['requestLineReasons'].update(changes)
            with self.assertRaises(ValueError): parse_proxy_diagnostic_receipt_v2(self.packet(value))
        value = copy.deepcopy(original); del value['requestLineReasons']['method']
        with self.assertRaises(ValueError): parse_proxy_diagnostic_receipt_v2(self.packet(value))
        proxy.request_line_reasons['method'] = 1
        with self.assertRaises(ValueError): proxy.build_proxy_receipt_v2()


if __name__ == '__main__': unittest.main()
