"""Strict diagnostic syntax only. Never accepts app source or wrapper custody."""
from teetime_joined_fixture import strict_json

KEYS = {'version', 'kind', 'passed', 'responseVerified', 'modelInvocations',
        'assistantCount', 'resultCount', 'thinkingCount', 'chunkCount',
        'normalProviderEnd', 'providerIteratorClosed', 'aborted', 'failure'}
BOOLS = ('passed', 'responseVerified', 'normalProviderEnd', 'providerIteratorClosed', 'aborted')
ORIGINS = {'sdk_iterator_exception', 'native_turn_failed',
           'native_stream_error_without_terminal', 'provider_initialization', 'unknown'}
HINTS = {'none', 'aborted', 'auth_hint', 'quota_hint', 'model_access_hint',
         'transport_hint', 'process_hint', 'other'}
CODES = {'provider_exception', 'chunk_limit', 'content_rejected', 'content_limit',
         'unexpected_chunk', 'order_rejected', 'terminal_rejected', 'response_mismatch',
         'stream_incomplete', 'lifecycle_incomplete', 'aborted', 'cleanup_failed'}


def validate_minimal_diagnostic(exit_code, raw):
    if (type(exit_code) is not int or exit_code not in (0, 1) or type(raw) is not bytes
            or not 1 <= len(raw) <= 4096 or not raw.isascii()):
        raise ValueError('bounded normal diagnostic result required')
    value = strict_json(raw)
    if (type(value) is not dict or set(value) != KEYS or type(value['version']) is not int
            or value['version'] != 1 or value['kind'] != 'teetime-minimal-diagnostic'
            or any(type(value[key]) is not bool for key in BOOLS)):
        raise ValueError('closed diagnostic schema required')
    bounds = {'modelInvocations': 1, 'assistantCount': 2, 'resultCount': 2,
              'thinkingCount': 64, 'chunkCount': 65}
    if any(type(value[key]) is not int or not 0 <= value[key] <= bound for key, bound in bounds.items()):
        raise ValueError('diagnostic count type or bound')
    count = value['chunkCount']
    categorized = sum(value[key] for key in ('assistantCount', 'resultCount', 'thinkingCount'))
    if categorized > count or (value['normalProviderEnd'] and not value['providerIteratorClosed']):
        raise ValueError('contradictory observed counts or lifecycle')
    complete = (value['modelInvocations'] == value['assistantCount'] == value['resultCount'] == 1
                and value['normalProviderEnd'] and value['providerIteratorClosed']
                and not value['aborted'] and count == value['thinkingCount']+2 and count <= 64)
    if value['passed']:
        if exit_code != 0 or not value['responseVerified'] or value['failure'] is not None or not complete:
            raise ValueError('contradictory diagnostic success')
        return value
    failed = value['failure']
    if (exit_code != 1 or value['responseVerified'] or type(failed) is not dict
            or set(failed) != {'code', 'exceptionCategory', 'provenance', 'cleanupFailure'}
            or type(failed['cleanupFailure']) is not bool
            or type(failed['code']) is not str or failed['code'] not in CODES
            or type(failed['exceptionCategory']) is not str or failed['exceptionCategory'] not in HINTS):
        raise ValueError('closed failure-only diagnostic required')
    origin = failed['provenance']
    if (type(origin) is not dict or set(origin) != {'version', 'origin'}
            or type(origin['version']) is not int or origin['version'] != 1
            or type(origin['origin']) is not str or origin['origin'] not in ORIGINS):
        raise ValueError('closed trusted origin syntax required')
    code, hint = failed['code'], failed['exceptionCategory']
    if failed['cleanupFailure'] and value['normalProviderEnd']:
        raise ValueError('cleanup exception contradicts normal provider end')
    if code == 'cleanup_failed' and not failed['cleanupFailure']:
        raise ValueError('cleanup failure evidence missing')
    if code not in {'provider_exception', 'terminal_rejected'} and (
            hint != 'none' or origin['origin'] != 'unknown'):
        raise ValueError('local rejection cannot manufacture provider provenance')
    if (hint == 'aborted' or code == 'aborted') and not value['aborted']:
        raise ValueError('abort evidence missing')
    if code == 'provider_exception' and hint == 'none':
        raise ValueError('provider exception hint missing')
    if value['modelInvocations'] == 0:
        if (code != 'aborted' or count != 0 or value['normalProviderEnd']
                or value['providerIteratorClosed'] or failed['cleanupFailure']):
            raise ValueError('invalid pre-invocation failure')
    elif not value['providerIteratorClosed'] and not (
            code == 'lifecycle_incomplete' and value['aborted']):
        raise ValueError('unclosed diagnostic must fail lifecycle')
    if (count == 65) != (code == 'chunk_limit') or (code == 'chunk_limit' and categorized != 64):
        raise ValueError('contradictory chunk-limit failure')
    if code in {'provider_exception', 'chunk_limit', 'content_rejected', 'content_limit',
                'unexpected_chunk', 'order_rejected', 'terminal_rejected', 'cleanup_failed'} and value['normalProviderEnd']:
        raise ValueError('premature rejection cannot have normal provider end')
    if code == 'terminal_rejected' and (hint != 'none' or value['resultCount'] == 0):
        raise ValueError('rejected native result missing')
    if code == 'response_mismatch' and not complete:
        raise ValueError('mismatch requires otherwise complete tiny response')
    if code == 'stream_incomplete' and (not value['normalProviderEnd']
            or value['resultCount'] != 0 or value['assistantCount'] > 1 or value['aborted']
            or categorized != count):
        raise ValueError('contradictory incomplete stream')
    if code == 'lifecycle_incomplete' and value['normalProviderEnd'] and value['providerIteratorClosed']:
        raise ValueError('lifecycle failure contradicts closed normal end')
    return value
