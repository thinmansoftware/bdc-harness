import asyncio
import socket
import unittest
from unittest.mock import patch
from unittest.mock import AsyncMock
import teetime_connect_proxy as proxy

from teetime_connect_proxy import parse_connect, validate_addresses, handle_client, ConnectPolicyError


class PolicyTests(unittest.TestCase):
    def test_bounded_user_agent_metadata_contract(self):
        prefix=b'CONNECT chatgpt.com:443 HTTP/1.1\r\n'
        for value in [b' codex_cli_rs/0.153.3 (Linux; x86_64) ', b'x'*256]:
            self.assertEqual(parse_connect(prefix+b'uSeR-aGeNt:'+value+b'\r\n\r\n'),'chatgpt.com')
        for value in [b'',b'   ',b'x'*257,b' '+b'x'*256,b'x'*256+b' ',
                      b'\tx',b'x\t',b'x\x01',b'x\x7f',b'x\xff']:
            with self.subTest(valueLength=len(value)),self.assertRaises(ConnectPolicyError):
                parse_connect(prefix+b'User-Agent:'+value+b'\r\n\r\n')
        with self.assertRaises(ConnectPolicyError) as duplicate:
            parse_connect(prefix+b'User-Agent: x\r\nuser-agent: x\r\n\r\n')
        self.assertEqual(duplicate.exception.reason,'duplicate_header')
        for name in [b'Authorization',b'Proxy-Authorization',b'Accept',b'X-Unknown']:
            with self.subTest(name=name),self.assertRaises(ConnectPolicyError) as denied:
                parse_connect(prefix+name+b': x\r\nUser-Agent: x\r\n\r\n')
            self.assertEqual(denied.exception.reason,'unsupported_header')

    def test_denial_reason_is_closed_and_contains_no_request_material(self):
        prefix = b'CONNECT chatgpt.com:443 HTTP/1.1\r\n'
        cases = [
            (b'CONNECT other.invalid:443 HTTP/1.1\r\n\r\n', 'request_line_or_destination'),
            (prefix+b'Host: chatgpt.com:443\r\nHost: chatgpt.com:443\r\n\r\n', 'duplicate_header'),
            (prefix+b'Authorization: synthetic-private-marker\r\n\r\n', 'unsupported_header'),
            (prefix+b'Host: other.invalid:443\r\n\r\n', 'invalid_header_value'),
            (prefix+b'Connection: close\r\n\r\n', 'invalid_header_value'),
            (prefix+b'no-colon\r\n\r\n', 'encoding_or_framing'),
            (prefix+b'\xff\r\n\r\n', 'encoding_or_framing'),
            (prefix+b'\r\npipelined-private-marker', 'encoding_or_framing'),
            (b'x'*4097, 'encoding_or_framing'),
        ]
        for data, reason in cases:
            with self.subTest(reason=reason):
                with self.assertRaises(proxy.ConnectPolicyError) as rejected:
                    parse_connect(data)
                self.assertIsInstance(rejected.exception, ValueError)
                self.assertEqual(rejected.exception.reason, reason)
                self.assertEqual(str(rejected.exception), reason)
                self.assertNotIn('private-marker', repr(rejected.exception))
                self.assertNotIn('other.invalid', repr(rejected.exception))
        with self.assertRaises(ValueError):
            proxy.ConnectPolicyError('arbitrary-private-marker')

    def test_reason_categories_preserve_all_previously_allowed_headers(self):
        for suffix in [b'', b'Host: chatgpt.com:443\r\n',
                       b'Connection: KEEP-ALIVE\r\n',
                       b'proxy-connection: keep-alive\r\n',
                       b'host: chatgpt.com:443\r\nConnection: keep-alive\r\n']:
            self.assertEqual(parse_connect(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n'+suffix+b'\r\n'), 'chatgpt.com')

    def test_closed_demo_duration_preserves_canary_default(self):
        from teetime_demo_execution import DEMO_LIMITS
        try:
            proxy.configure_task('supervised-demo')
            self.assertEqual(proxy.TOTAL_SECONDS,DEMO_LIMITS['controllerSeconds'])
            with self.assertRaises(ValueError): proxy.configure_task('unbounded')
        finally:
            proxy.configure_task('canary')
        self.assertEqual(proxy.TOTAL_SECONDS,300)
        self.assertEqual(proxy.IDLE_SECONDS,30)

    def test_exact_authority(self):
        self.assertEqual(parse_connect(b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n'), 'chatgpt.com')

    def test_invalid_authorities_and_methods(self):
        for authority in ['auth.openai.com:443', 'api.openai.com:443', 'chatgpt.com:80',
                          'chatgpt.com.:443', 'user@chatgpt.com:443', '127.0.0.1:443',
                          '[::1]:443', 'CHATGPT.COM:443', 'chatgpt.com:443/path']:
            with self.subTest(authority=authority), self.assertRaises(ValueError):
                parse_connect(('CONNECT '+authority+' HTTP/1.1\r\n\r\n').encode())
        with self.assertRaises(ValueError):
            parse_connect(b'GET https://chatgpt.com HTTP/1.1\r\n\r\n')

    def test_body_pipelining_and_ambiguous_headers_rejected(self):
        for suffix in [b'Content-Length: 1\r\n\r\nx', b'Transfer-Encoding: chunked\r\n\r\n',
                       b'Host: example.com\r\n\r\n', b'Host: chatgpt.com:443\r\nHost: chatgpt.com:443\r\n\r\n',
                       b'Authorization: secret\r\n\r\n', b'\r\nCONNECT other:443 HTTP/1.1\r\n\r\n']:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                parse_connect(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n'+suffix)
        with self.assertRaises(ValueError):
            parse_connect(b'x'*4097)

    def test_all_dns_addresses_must_be_public_ipv4(self):
        def record(ip): return (socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip,443))
        self.assertEqual(validate_addresses([record('104.18.32.7')]), '104.18.32.7')
        for ip in ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.0.0.1','224.0.0.1','0.0.0.0','198.18.0.1']:
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                validate_addresses([record('104.18.32.7'),record(ip)])
        with self.assertRaises(ValueError): validate_addresses([])
        with self.assertRaises(ValueError):
            validate_addresses([(socket.AF_INET6,socket.SOCK_STREAM,6,'',('::ffff:104.18.32.7',443,0,0))])


class HandlerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        proxy.process_bytes = 0
        proxy.outcomes.clear()
        self.assertEqual(proxy.active, 0)

    async def test_bidirectional_stream_and_numeric_connect(self):
        async def echo(reader, writer):
            packet=await reader.read(100)
            writer.write(packet);await writer.drain();writer.close();await writer.wait_closed()
        upstream=await asyncio.start_server(echo,'127.0.0.1',0)
        server=await asyncio.start_server(handle_client,'127.0.0.1',0)
        connected=[]
        async def dial(host, port, **kwargs):
            connected.append((host,port))
            return await ORIGINAL_OPEN('127.0.0.1',upstream.sockets[0].getsockname()[1])
        loop=asyncio.get_running_loop()
        records=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('104.18.32.7',443))]
        try:
            with patch.object(loop,'getaddrinfo',AsyncMock(return_value=records)), patch.object(proxy.asyncio,'open_connection',dial):
                reader,writer=await ORIGINAL_OPEN('127.0.0.1',server.sockets[0].getsockname()[1])
                writer.write(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n');await writer.drain()
                self.assertIn(b'200',await reader.readuntil(b'\r\n\r\n'))
                writer.write(b'\x16synthetic-stream');await writer.drain()
                self.assertEqual(await reader.read(),b'\x16synthetic-stream')
                writer.close();await writer.wait_closed()
                await asyncio.sleep(.02)
                self.assertEqual(proxy.active,0)
                self.assertEqual(connected,[('104.18.32.7',443)])
                self.assertEqual(proxy.process_bytes,34)
        finally:
            server.close();upstream.close();await server.wait_closed();await upstream.wait_closed()

    async def test_header_timeout_and_connection_limit(self):
        server=await asyncio.start_server(handle_client,'127.0.0.1',0)
        try:
            with patch.object(proxy,'HEADER_SECONDS',.02):
                reader,writer=await ORIGINAL_OPEN('127.0.0.1',server.sockets[0].getsockname()[1])
                self.assertIn(b'403',await reader.read())
                writer.close();await writer.wait_closed();await asyncio.sleep(.02)
                self.assertEqual(proxy.active,0)
                self.assertEqual(proxy.outcomes['timeout'],1)
            with patch.object(proxy,'TUNNEL_LIMIT',0):
                reader,writer=await ORIGINAL_OPEN('127.0.0.1',server.sockets[0].getsockname()[1])
                self.assertIn(b'403',await reader.read())
                writer.close();await writer.wait_closed();await asyncio.sleep(.02)
                self.assertEqual(proxy.active,0)
        finally:
            server.close();await server.wait_closed()

    async def test_tunnel_limits_and_cancellation_cleanup(self):
        loop=asyncio.get_running_loop()
        records=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('104.18.32.7',443))]
        for limit,value in [('BYTE_LIMIT',1),('PROCESS_BYTE_LIMIT',1),('IDLE_SECONDS',.02),('TOTAL_SECONDS',.15)]:
            with self.subTest(limit=limit):
                async def sink(reader,writer):
                    await reader.read();writer.close();await writer.wait_closed()
                upstream=await asyncio.start_server(sink,'127.0.0.1',0)
                server=await asyncio.start_server(handle_client,'127.0.0.1',0)
                async def dial(host,port,**kwargs):
                    return await ORIGINAL_OPEN('127.0.0.1',upstream.sockets[0].getsockname()[1])
                try:
                    with patch.object(loop,'getaddrinfo',AsyncMock(return_value=records)),patch.object(proxy.asyncio,'open_connection',dial),patch.object(proxy,limit,value):
                        reader,writer=await ORIGINAL_OPEN('127.0.0.1',server.sockets[0].getsockname()[1])
                        writer.write(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n');await writer.drain()
                        self.assertIn(b'200',await reader.readuntil(b'\r\n\r\n'))
                        if 'BYTE' in limit:
                            writer.write(b'\x16bounded');await writer.drain()
                        self.assertEqual(await asyncio.wait_for(reader.read(),1),b'')
                        writer.close();await writer.wait_closed();await asyncio.sleep(.02)
                        self.assertEqual(proxy.active,0)
                finally:
                    server.close();upstream.close();await server.wait_closed();await upstream.wait_closed()

    async def test_explicit_handler_cancellation_closes_both_streams(self):
        loop=asyncio.get_running_loop()
        records=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('104.18.32.7',443))]
        handlers=[]
        upstream_closed=asyncio.Event()
        async def sink(reader,writer):
            await reader.read()
            writer.close();await writer.wait_closed();upstream_closed.set()
        def accepted(reader,writer):
            handlers.append(asyncio.create_task(handle_client(reader,writer)))
        upstream=await asyncio.start_server(sink,'127.0.0.1',0)
        server=await asyncio.start_server(accepted,'127.0.0.1',0)
        async def dial(host,port,**kwargs):
            return await ORIGINAL_OPEN('127.0.0.1',upstream.sockets[0].getsockname()[1])
        try:
            with patch.object(loop,'getaddrinfo',AsyncMock(return_value=records)),patch.object(proxy.asyncio,'open_connection',dial):
                reader,writer=await ORIGINAL_OPEN('127.0.0.1',server.sockets[0].getsockname()[1])
                writer.write(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n');await writer.drain()
                self.assertIn(b'200',await reader.readuntil(b'\r\n\r\n'))
                handlers[0].cancel()
                with self.assertRaises(asyncio.CancelledError): await handlers[0]
                self.assertEqual(await asyncio.wait_for(reader.read(),1),b'')
                await asyncio.wait_for(upstream_closed.wait(),1)
                self.assertEqual(proxy.active,0)
                writer.close();await writer.wait_closed()
        finally:
            for task in handlers: task.cancel()
            await asyncio.gather(*handlers,return_exceptions=True)
            server.close();upstream.close();await server.wait_closed();await upstream.wait_closed()

    async def test_dns_timeout_and_private_answer_close_without_dial(self):
        loop=asyncio.get_running_loop()
        async def slow(*args,**kwargs): await asyncio.sleep(1)
        for resolver in [AsyncMock(return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]),slow]:
            server=await asyncio.start_server(handle_client,'127.0.0.1',0)
            try:
                with patch.object(loop,'getaddrinfo',resolver),patch.object(proxy.asyncio,'open_connection') as connect,patch.object(proxy,'CONNECT_SECONDS',.02):
                    reader,writer=await ORIGINAL_OPEN('127.0.0.1',server.sockets[0].getsockname()[1])
                    writer.write(b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n');await writer.drain()
                    self.assertIn(b'403',await asyncio.wait_for(reader.read(),1))
                    connect.assert_not_called();writer.close();await writer.wait_closed();await asyncio.sleep(.02)
                    self.assertEqual(proxy.active,0)
            finally:
                server.close();await server.wait_closed()

    async def test_denial_never_opens_upstream(self):
        server = await asyncio.start_server(handle_client, '127.0.0.1', 0)
        try:
            with patch('teetime_connect_proxy.asyncio.open_connection') as connect:
                # Use original API via a saved function for the client connection.
                reader, writer = await ORIGINAL_OPEN('127.0.0.1',server.sockets[0].getsockname()[1])
                writer.write(b'CONNECT auth.openai.com:443 HTTP/1.1\r\n\r\n');await writer.drain()
                self.assertIn(b'403',await reader.read())
                connect.assert_not_called()
                writer.close();await writer.wait_closed()
        finally:
            server.close();await server.wait_closed()


ORIGINAL_OPEN = asyncio.open_connection
if __name__ == '__main__': unittest.main()
