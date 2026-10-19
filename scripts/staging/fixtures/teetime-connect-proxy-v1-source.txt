"""Unregistered canary-only CONNECT candidate. No TLS interception or payload logs.

Runtime entrypoint has no configurable destinations, resolver or upstream hook.
Docker network confinement and separate worker qualification remain mandatory.
"""
import asyncio
import ipaddress
import socket
import json
from collections import Counter

HEADER_LIMIT = 4096
TUNNEL_LIMIT = 8
BYTE_LIMIT = 16 * 1024 * 1024
TOTAL_SECONDS = 300
IDLE_SECONDS = 30
HEADER_SECONDS = 5
CONNECT_SECONDS = 10
PROCESS_BYTE_LIMIT = 32 * 1024 * 1024
active = 0
process_bytes = 0
outcomes = Counter()
parser_reasons = Counter()
non_parser_reasons = Counter()
diagnostic_invalid = False

DENIAL_REASONS = frozenset({'request_line_or_destination', 'duplicate_header',
                          'unsupported_header', 'invalid_header_value',
                          'encoding_or_framing'})
NON_PARSER_REASONS = frozenset({'connection_limit', 'header_read', 'dns_lookup',
                               'dns_validation', 'upstream_connect', 'tunnel'})
OUTCOME_NAMES = frozenset({'header_or_destination_denied', 'dns_denied', 'byte_limit',
                           'timeout', 'rejected_or_closed', 'closed'})


def build_proxy_receipt(diagnostic=False):
    if not diagnostic:
        return {'outcomes': dict(outcomes), 'bytes': process_bytes, 'active': active}
    if diagnostic_invalid or set(outcomes)-OUTCOME_NAMES or set(parser_reasons)-DENIAL_REASONS or set(non_parser_reasons)-NON_PARSER_REASONS:
        raise ValueError('invalid diagnostic accounting')
    counts = {key: outcomes.get(key, 0) for key in sorted(OUTCOME_NAMES)}
    parsers = {key: parser_reasons.get(key, 0) for key in sorted(DENIAL_REASONS)}
    phases = {key: non_parser_reasons.get(key, 0) for key in sorted(NON_PARSER_REASONS)}
    values = [process_bytes, active, *counts.values(), *parsers.values(), *phases.values()]
    if any(type(value) is not int or not 0 <= value <= 10**9 for value in values):
        raise ValueError('invalid diagnostic counters')
    failures = counts['rejected_or_closed'] + counts['timeout']
    if (active != 0 or process_bytes > 64*1024*1024
            or sum(parsers.values()) != counts['header_or_destination_denied']
            or sum(parsers.values()) + sum(phases.values()) != failures
            or phases['dns_validation'] != counts['dns_denied']
            or failures > counts['closed']):
        raise ValueError('inconsistent diagnostic counters')
    return {'version': 1, 'kind': 'teetime-proxy-diagnostic', 'outcomes': counts,
            'bytes': process_bytes, 'active': active, 'parserReasons': parsers,
            'nonParserReasons': phases}


class ConnectPolicyError(ValueError):
    """Fixed diagnostic reason only; never retain request bytes or header data."""
    def __init__(self, reason):
        if reason not in DENIAL_REASONS:
            raise ValueError('unknown policy denial reason')
        self.reason = reason
        super().__init__(reason)


def configure_task(task):
    # Fixed selectors only, no caller-supplied duration or destination override.
    global TOTAL_SECONDS
    if task not in ['canary', 'supervised-demo']:
        raise ValueError('closed proxy task required')
    TOTAL_SECONDS = 720 if task == 'supervised-demo' else 300


def parse_connect(data):
    if len(data) > HEADER_LIMIT or not data.endswith(b'\r\n\r\n'):
        raise ConnectPolicyError('encoding_or_framing')
    try:
        lines = data.decode('ascii').split('\r\n')
    except UnicodeError:
        raise ConnectPolicyError('encoding_or_framing') from None
    if lines[0] != 'CONNECT chatgpt.com:443 HTTP/1.1' or lines[-2:] != ['', '']:
        raise ConnectPolicyError('request_line_or_destination')
    seen = set()
    for line in lines[1:-2]:
        key, sep, value = line.partition(':')
        key = key.lower()
        raw_value = value
        value = value.strip(' ')
        if not sep:
            raise ConnectPolicyError('encoding_or_framing')
        if key in seen:
            raise ConnectPolicyError('duplicate_header')
        seen.add(key)
        if key == 'host' and value == 'chatgpt.com:443':
            continue
        if key in ['proxy-connection', 'connection'] and value.lower() == 'keep-alive':
            continue
        if key == 'user-agent' and value and len(raw_value) <= 256 and all(
                0x20 <= ord(character) <= 0x7e for character in raw_value):
            continue
        raise ConnectPolicyError('invalid_header_value' if key in
                                 ['host', 'proxy-connection', 'connection', 'user-agent']
                                 else 'unsupported_header')
    return 'chatgpt.com'


def validate_addresses(records):
    if not records:
        raise ValueError('empty DNS result')
    addresses = []
    for family, kind, protocol, _, address in records:
        ip = ipaddress.ip_address(address[0])
        if (family != socket.AF_INET or kind != socket.SOCK_STREAM or protocol != 6
                or ip.version != 4 or not ip.is_global or ip.is_multicast
                or ip.is_reserved or address[1] != 443):
            raise ValueError('non-public destination')
        addresses.append(str(ip))
    return addresses[0]


async def handle_client(reader, writer):
    global active, process_bytes, diagnostic_invalid
    upstream = None
    admitted = False
    established = False
    tasks = []
    phase = 'connection_limit'
    parser_reason = None
    try:
        if active >= TUNNEL_LIMIT:
            raise ValueError('connection bound')
        active += 1
        admitted = True
        phase = 'header_read'
        async with asyncio.timeout(TOTAL_SECONDS):
            data = bytearray()
            async with asyncio.timeout(HEADER_SECONDS):
                while not data.endswith(b'\r\n\r\n'):
                    part = await reader.read(1024)
                    if not part:
                        raise ValueError('incomplete headers')
                    data.extend(part)
                    if len(data) > HEADER_LIMIT or (b'\r\n\r\n' in data and not data.endswith(b'\r\n\r\n')):
                        raise ValueError('headers or pipelining rejected')
            try:
                phase = 'parser'
                host = parse_connect(bytes(data))
            except ValueError as error:
                outcomes['header_or_destination_denied'] += 1
                if type(error) is ConnectPolicyError and error.reason in DENIAL_REASONS:
                    parser_reason = error.reason
                else:
                    diagnostic_invalid = True
                raise
            except Exception:
                diagnostic_invalid = True
                raise
            loop = asyncio.get_running_loop()
            async with asyncio.timeout(CONNECT_SECONDS):
                phase = 'dns_lookup'
                records = await loop.getaddrinfo(host, 443, family=socket.AF_INET, type=socket.SOCK_STREAM, proto=6)
                try:
                    phase = 'dns_validation'
                    address = validate_addresses(records)
                except ValueError:
                    outcomes['dns_denied'] += 1
                    raise
                phase = 'upstream_connect'
                upstream_reader, upstream = await asyncio.open_connection(address, 443, family=socket.AF_INET)
            phase = 'tunnel'
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await writer.drain()
            established = True
            count = 0

            async def pump(source, destination, require_tls=False):
                nonlocal count
                global process_bytes
                first = True
                while True:
                    async with asyncio.timeout(IDLE_SECONDS):
                        part = await source.read(16384)
                        if not part:
                            return
                        # Reject obvious HTTP pipelining; this is not TLS/SNI validation.
                        if first and require_tls and part[0] != 0x16:
                            raise ValueError('TLS required')
                        first = False
                        count += len(part)
                        process_bytes += len(part)
                        if count > BYTE_LIMIT or process_bytes > PROCESS_BYTE_LIMIT:
                            outcomes['byte_limit'] += 1
                            raise ValueError('byte bound')
                        destination.write(part)
                        await destination.drain()

            tasks = [asyncio.create_task(pump(reader, upstream, True)),
                     asyncio.create_task(pump(upstream_reader, writer))]
            finished, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in finished:
                task.result()
    except (ValueError, UnicodeError, OSError, TimeoutError, asyncio.IncompleteReadError) as error:
        outcomes['timeout' if isinstance(error, TimeoutError) else 'rejected_or_closed'] += 1
        if parser_reason is not None:
            parser_reasons[parser_reason] += 1
        elif phase in NON_PARSER_REASONS:
            non_parser_reasons[phase] += 1
        else:
            diagnostic_invalid = True
        if not established:
            writer.write(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for stream in [upstream, writer]:
            if stream is not None:
                stream.close()
                try:
                    await asyncio.wait_for(stream.wait_closed(), 2)
                except (OSError, TimeoutError):
                    pass
        if admitted:
            active -= 1
        outcomes['closed'] += 1


async def main(diagnostic=False):
    server = await asyncio.start_server(handle_client, '0.0.0.0', 3128, limit=HEADER_LIMIT)
    print('{"proxyReady":true,"diagnosticVersion":1}' if diagnostic else '{"proxyReady":true}', flush=True)
    async with server:
        try:
            await asyncio.wait_for(server.serve_forever(), TOTAL_SECONDS)
        except TimeoutError:
            pass


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--task', choices=['canary', 'supervised-demo'], default='canary')
    parser.add_argument('--diagnostic-receipt', action='store_true')
    args = parser.parse_args()
    configure_task(args.task)
    try:
        asyncio.run(main(args.diagnostic_receipt))
    except KeyboardInterrupt:
        pass
    finally:
        print(json.dumps(build_proxy_receipt(args.diagnostic_receipt)))
