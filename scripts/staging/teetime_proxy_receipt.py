"""Allowlisted, nonsecret proxy counters. Never return raw stream text."""
import json

NAMES = {'header_or_destination_denied', 'dns_denied', 'byte_limit', 'timeout',
         'rejected_or_closed', 'closed'}


def parse_proxy_receipt(raw):
    if not isinstance(raw, bytes) or len(raw) > 4096:
        raise ValueError('invalid proxy receipt bound')
    lines = raw.splitlines()
    if len(lines) != 2 or json.loads(lines[0]) != {'proxyReady': True}:
        raise ValueError('missing proxy ready receipt')
    data = json.loads(lines[1])
    if set(data) != {'outcomes', 'bytes', 'active'} or not isinstance(data['outcomes'], dict):
        raise ValueError('invalid proxy counter fields')
    if set(data['outcomes'])-NAMES:
        raise ValueError('unknown proxy counter')
    values = [data['bytes'], data['active'], *data['outcomes'].values()]
    if any(type(value) is not int or not 0 <= value <= 10**9 for value in values):
        raise ValueError('invalid proxy counter value')
    if data['bytes'] > 64*1024*1024 or data['active'] != 0:
        raise ValueError('proxy not quiescent or byte bound')
    return {'bytes': data['bytes'], **{name: data['outcomes'].get(name, 0) for name in sorted(NAMES)}}
