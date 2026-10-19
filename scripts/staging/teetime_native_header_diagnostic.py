"""Offline-only denial classification. Never relax policy or return request data."""
from collections import Counter
from teetime_connect_proxy import parse_connect, ConnectPolicyError

CLASSES = {'user-agent': 'user_agent', 'proxy-authorization': 'proxy_authorization',
           'authorization': 'authorization', 'accept': 'accept'}
POLICY_HEADERS = frozenset({'host', 'connection', 'proxy-connection', 'user-agent'})


def classify_native_connect(data):
    try:
        parse_connect(data)
        return {'reason': 'policy_accepted_mock_rejected', 'unsupportedHeaders': {}}
    except ConnectPolicyError as error:
        reason = error.reason
    counts = Counter()
    if reason == 'unsupported_header':
        # Successful ASCII/framing validation is a prerequisite to this reason.
        # Names/values live only in this bounded call; return source-owned enums.
        for line in data.decode('ascii').split('\r\n')[1:-2]:
            name, _, _value = line.partition(':')
            name = name.lower()
            if name not in POLICY_HEADERS:
                category = CLASSES.get(name, 'other')
                counts[category] = min(32, counts[category]+1)
    return {'reason': reason, 'unsupportedHeaders': dict(counts)}
