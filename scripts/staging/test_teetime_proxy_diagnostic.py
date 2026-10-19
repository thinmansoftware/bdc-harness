"""Actual handler accounting with synthetic sockets; no network or account."""
import asyncio
import json
import socket
import unittest
from unittest.mock import AsyncMock, patch
import teetime_connect_proxy as proxy

from teetime_proxy_diagnostic_receipt import parse_proxy_diagnostic_receipt

HEADER = b'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'
PUBLIC = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('104.18.32.7', 443))]


class Reader:
    def __init__(self, *parts): self.parts = list(parts)
    async def read(self, _size): return self.parts.pop(0) if self.parts else b''


class Writer:
    def __init__(self, drain_error=None, close_error=None):
        self.data = bytearray(); self.drain_error = drain_error; self.close_error = close_error
    def write(self, raw): self.data.extend(raw)
    async def drain(self):
        if self.drain_error: raise self.drain_error
    def close(self): pass
    async def wait_closed(self):
        if self.close_error: raise self.close_error


class ProxyDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        proxy.active = proxy.process_bytes = 0; proxy.outcomes.clear()
        for name in ['parser_reasons', 'non_parser_reasons']:
            if hasattr(proxy, name): getattr(proxy, name).clear()
        proxy.diagnostic_invalid = False

    def receipt(self):
        return proxy.build_proxy_receipt(True)

    def roundtrip(self):
        value = self.receipt()
        ready = {'proxyReady': True, 'diagnosticVersion': 1}
        raw = (json.dumps(ready)+'\n'+json.dumps(value)+'\n').encode('ascii')
        self.assertEqual(parse_proxy_diagnostic_receipt(raw), value)
        self.assertNotIn('PRIVATE', raw.decode())
        self.assertNotIn('Authorization', raw.decode())
        return value

    async def test_all_parser_reasons_from_actual_handler_are_closed_and_private(self):
        prefix = b'CONNECT chatgpt.com:443 HTTP/1.1\r\n'
        packets = [b'CONNECT PRIVATE.invalid:443 HTTP/1.1\r\n\r\n',
                   prefix+b'Host: chatgpt.com:443\r\nHost: chatgpt.com:443\r\n\r\n',
                   prefix+b'Authorization: PRIVATE\r\n\r\n',
                   prefix+b'Host: PRIVATE\r\n\r\n', prefix+b'\xff\r\n\r\n']
        for raw in packets: await proxy.handle_client(Reader(raw), Writer())
        value = self.roundtrip()
        self.assertEqual(value['parserReasons'], {name: 1 for name in proxy.DENIAL_REASONS})
        self.assertEqual(sum(value['nonParserReasons'].values()), 0)
        self.assertEqual(value['outcomes']['header_or_destination_denied'], 5)

    async def test_non_parser_phase_boundaries_include_connect_success_write_failure(self):
        proxy.active = 8
        await proxy.handle_client(Reader(HEADER), Writer()); proxy.active = 0
        await proxy.handle_client(Reader(), Writer())
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', AsyncMock(side_effect=socket.gaierror('PRIVATE'))):
            await proxy.handle_client(Reader(HEADER), Writer())
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))])):
            await proxy.handle_client(Reader(HEADER), Writer())
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=PUBLIC)):
            with patch.object(proxy.asyncio, 'open_connection', AsyncMock(side_effect=OSError('PRIVATE'))):
                await proxy.handle_client(Reader(HEADER), Writer())
            with patch.object(proxy.asyncio, 'open_connection', AsyncMock(return_value=(Reader(), Writer()))):
                await proxy.handle_client(Reader(HEADER), Writer(drain_error=OSError('PRIVATE')))
        self.assertEqual(self.roundtrip()['nonParserReasons'], {
            'connection_limit': 1, 'header_read': 1, 'dns_lookup': 1,
            'dns_validation': 1, 'upstream_connect': 1, 'tunnel': 1})

    async def test_two_pump_limits_are_one_outer_failure(self):
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=PUBLIC)), \
                patch.object(proxy.asyncio, 'open_connection', AsyncMock(return_value=(Reader(b'\x16xx'), Writer()))), \
                patch.object(proxy, 'BYTE_LIMIT', 1):
            await proxy.handle_client(Reader(HEADER, b'\x16xx'), Writer())
        value = self.roundtrip()
        self.assertEqual(value['outcomes']['byte_limit'], 2)
        self.assertEqual(value['nonParserReasons']['tunnel'], 1)
        self.assertEqual(value['outcomes']['rejected_or_closed'], 1)

    async def test_eof_and_suppressed_cleanup_error_are_not_handled_failures(self):
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=PUBLIC)), \
                patch.object(proxy.asyncio, 'open_connection', AsyncMock(return_value=(Reader(), Writer(close_error=OSError('PRIVATE'))))):
            await proxy.handle_client(Reader(HEADER), Writer(close_error=TimeoutError('PRIVATE')))
        value = self.roundtrip()
        self.assertEqual(sum(value['parserReasons'].values())+sum(value['nonParserReasons'].values()), 0)
        self.assertEqual(value['outcomes']['closed'], 1)

    async def test_unknown_parser_failure_invalidates_accounting_even_if_totals_are_masked(self):
        with patch.object(proxy, 'parse_connect', side_effect=ValueError('PRIVATE')):
            await proxy.handle_client(Reader(HEADER), Writer())
        # A coincidental/mutated aggregate must not conceal the unclassified parser failure.
        if hasattr(proxy, 'parser_reasons'): proxy.parser_reasons['unsupported_header'] = 1
        with self.assertRaises(ValueError): self.receipt()

    async def test_cancellation_in_each_asynchronous_phase_is_not_a_handled_failure(self):
        loop = asyncio.get_running_loop()
        for phase in ['headers', 'dns', 'connect', 'tunnel']:
            started = asyncio.Event()
            async def block(*_args, **_kwargs):
                started.set(); await asyncio.Event().wait()
            reader = Reader(HEADER)
            if phase == 'headers': reader.read = block
            dns = AsyncMock(side_effect=block) if phase == 'dns' else AsyncMock(return_value=PUBLIC)
            upstream = Reader()
            if phase == 'tunnel': upstream.read = block
            dial = AsyncMock(side_effect=block) if phase == 'connect' else AsyncMock(return_value=(upstream, Writer()))
            # Keep the other tunnel direction open until cancellation too.
            if phase == 'tunnel':
                original = reader.read
                async def client_read(size):
                    if reader.parts: return await original(size)
                    return await block()
                reader.read = client_read
            with patch.object(loop, 'getaddrinfo', dns), patch.object(proxy.asyncio, 'open_connection', dial):
                task = asyncio.create_task(proxy.handle_client(reader, Writer()))
                await asyncio.wait_for(started.wait(), 1); task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
        value = self.roundtrip()
        self.assertEqual(value['outcomes']['closed'], 4)
        self.assertEqual(sum(value['parserReasons'].values())+sum(value['nonParserReasons'].values()), 0)


if __name__ == '__main__': unittest.main()
