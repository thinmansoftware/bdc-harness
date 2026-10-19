"""Strict independent parser for closed proxy diagnostic v1; no raw diagnostics."""
import json

OUTCOMES = {'header_or_destination_denied', 'dns_denied', 'byte_limit', 'timeout',
            'rejected_or_closed', 'closed'}
PARSER = {'request_line_or_destination', 'duplicate_header', 'unsupported_header',
          'invalid_header_value', 'encoding_or_framing'}
PHASES = {'connection_limit', 'header_read', 'dns_lookup', 'dns_validation',
          'upstream_connect', 'tunnel'}


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate diagnostic field')
        result[key] = value
    return result


def _constant(_value):
    raise ValueError('invalid diagnostic constant')


def parse_proxy_diagnostic_receipt(raw):
    return _parse(raw, 1)


def parse_proxy_diagnostic_receipt_v2(raw):
    return _parse(raw, 2)


def _parse(raw, version):
    if type(raw) is not bytes or len(raw) > 4096:
        raise ValueError('invalid diagnostic bound')
    try:
        lines = raw.decode('ascii').splitlines()
    except UnicodeError:
        raise ValueError('invalid diagnostic encoding') from None
    if len(lines) != 2:
        raise ValueError('invalid diagnostic framing')
    ready, data = [json.loads(line, object_pairs_hook=_pairs, parse_constant=_constant)
                   for line in lines]
    if (type(ready) is not dict or set(ready) != {'proxyReady', 'diagnosticVersion'}
            or ready['proxyReady'] is not True or type(ready['diagnosticVersion']) is not int
            or ready['diagnosticVersion'] != version):
        raise ValueError('invalid diagnostic ready record')
    if (type(data) is not dict or set(data) != {'version', 'kind', 'outcomes', 'bytes',
            'active', 'parserReasons', 'nonParserReasons'} | ({'requestLineReasons'} if version == 2 else set())
            or type(data['version']) is not int or data['version'] != version
            or data['kind'] != 'teetime-proxy-diagnostic'):
        raise ValueError('invalid diagnostic fields')
    for key, names in [('outcomes', OUTCOMES), ('parserReasons', PARSER), ('nonParserReasons', PHASES)]:
        if type(data[key]) is not dict or set(data[key]) != names:
            raise ValueError('invalid diagnostic counter fields')
    values = [data['bytes'], data['active'], *data['outcomes'].values(),
              *data['parserReasons'].values(), *data['nonParserReasons'].values()]
    if any(type(value) is not int or not 0 <= value <= 10**9 for value in values):
        raise ValueError('invalid diagnostic counter value')
    if version == 2:
        reasons = data['requestLineReasons']
        if (type(reasons) is not dict or set(reasons) != {'framing', 'method', 'http_version', 'authority', 'unknown'}
                or any(type(count) is not int or not 0 <= count <= 10**9 for count in reasons.values())
                or sum(reasons.values()) != data['parserReasons']['request_line_or_destination']):
            raise ValueError('request-line accounting differs')
    counts = data['outcomes']
    failures = counts['rejected_or_closed'] + counts['timeout']
    if (data['active'] != 0 or data['bytes'] > 64*1024*1024
            or sum(data['parserReasons'].values()) != counts['header_or_destination_denied']
            or sum(data['parserReasons'].values()) + sum(data['nonParserReasons'].values()) != failures
            or data['nonParserReasons']['dns_validation'] != counts['dns_denied']
            or failures > counts['closed']):
        raise ValueError('inconsistent diagnostic counters')
    return data
