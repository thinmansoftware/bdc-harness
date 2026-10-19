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
    return _validate(exit_code, raw, 1)


def validate_minimal_diagnostic_v2(exit_code, raw):
    """Explicit v2 syntax; never upgrades or changes historical v1 evidence."""
    return _validate(exit_code, raw, 2)


def _ordered(values, allowed, *, nonempty=True):
    if (type(values) is not list or len(values) > len(allowed) or (nonempty and not values)
            or any(type(item) is not type(allowed[0]) for item in values)
            or values != [item for item in allowed if item in values]):
        raise ValueError('closed canonical diagnostic array required')
    if 'other' in values and values != ['other']:
        raise ValueError('neutral classification cannot mix with observations')


def _sdk_evidence(value):
    keys = {'version', 'kind', 'exitCode', 'signal', 'stderrCategory', 'startupEvidence'}
    if (type(value) is not dict or set(value) != keys or type(value['version']) is not int
            or value['version'] != 1 or value['kind'] not in ['cli-exit', 'sdk-parse', 'aborted', 'other']):
        raise ValueError('closed SDK evidence required')
    code, signal, startup = value['exitCode'], value['signal'], value['startupEvidence']
    if value['kind'] != 'cli-exit':
        if code is not None or signal is not None or startup is not None or value['stderrCategory'] != 'other':
            raise ValueError('non-exit SDK classification has exit evidence')
        return
    if (code is None) == (signal is None):
        raise ValueError('exactly one SDK exit observation required')
    if code is not None and (type(code) is not int or not 0 <= code <= 255):
        raise ValueError('SDK exit code bound')
    if signal is not None and signal not in ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGINT', 'SIGPIPE', 'SIGBUS', 'SIGILL']:
        raise ValueError('SDK signal allowlist')
    if type(startup) is not dict or set(startup) != {'stderrBytes', 'classificationLimited', 'startupStages', 'causeCategories', 'osErrnos'}:
        raise ValueError('closed startup evidence required')
    size = startup['stderrBytes']
    if (type(size) is not int or not 0 <= size <= 10**9
            or type(startup['classificationLimited']) is not bool
            or startup['classificationLimited'] != (size > 65536)):
        raise ValueError('startup byte classification contradiction')
    stages, causes, errnos = startup['startupStages'], startup['causeCategories'], startup['osErrnos']
    _ordered(stages, ['config-overrides', 'codex-home', 'exec-policy', 'config-load', 'app-server-start', 'thread-start', 'model-catalog', 'other'])
    _ordered(causes, ['model-catalog-json', 'auth-key-missing', 'os-error', 'other'])
    _ordered(errnos, [2, 11, 13, 24, 28, 30], nonempty=False)
    if ('os-error' in causes) != bool(errnos) or ('model-catalog' in stages and 'model-catalog-json' not in causes):
        raise ValueError('startup cause classification contradiction')
    if size == 0 and (stages != ['other'] or causes != ['other'] or errnos):
        raise ValueError('startup observations without bytes')
    category = stages[0] if len(stages) == 1 and stages[0] in ['config-overrides', 'codex-home', 'exec-policy', 'config-load', 'app-server-start'] else 'other'
    if value['stderrCategory'] != category: raise ValueError('startup stage summary differs')


def _validate(exit_code, raw, version):
    if (type(exit_code) is not int or exit_code not in (0, 1) or type(raw) is not bytes
            or not 1 <= len(raw) <= 4096 or not raw.isascii()):
        raise ValueError('bounded normal diagnostic result required')
    value = strict_json(raw)
    if (type(value) is not dict or set(value) != KEYS or type(value['version']) is not int
            or value['version'] != version or value['kind'] != 'teetime-minimal-diagnostic'
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
            or set(failed) != ({'code', 'exceptionCategory', 'provenance', 'cleanupFailure'} | ({'sdkEvidence'} if version == 2 else set()))
            or type(failed['cleanupFailure']) is not bool
            or type(failed['code']) is not str or failed['code'] not in CODES
            or type(failed['exceptionCategory']) is not str or failed['exceptionCategory'] not in HINTS):
        raise ValueError('closed failure-only diagnostic required')
    origin = failed['provenance']
    if (type(origin) is not dict or set(origin) != {'version', 'origin'}
            or type(origin['version']) is not int or origin['version'] != 1
            or type(origin['origin']) is not str or origin['origin'] not in ORIGINS):
        raise ValueError('closed trusted origin syntax required')
    if version == 2:
        if origin['origin'] == 'sdk_iterator_exception': _sdk_evidence(failed['sdkEvidence'])
        elif failed['sdkEvidence'] is not None: raise ValueError('SDK evidence without SDK provenance')
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
