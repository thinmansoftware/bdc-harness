"""Validate collected demo bytes. Does not establish approval or wrapper custody."""
import base64

from teetime_demo_case import parse_demo_artifact
from teetime_joined_fixture import exact, strict_json

# 65536 artifact bytes expand to 87384 base64 bytes, plus bounded metadata.
MAX_DEMO_TASK_RESULT = 90112
FAILURE_STAGES = ('input','policy','provider_initialization','stream','finalization')
EXCEPTION_HINTS = ('none','aborted','auth_hint','quota_hint','model_access_hint','transport_hint','process_hint','other')
EVENT_TYPES = ('none','assistant','result','thinking','system','tool_call','tool_result','other')


def validate_failure_diagnostic(value):
    if (type(value) is not dict or set(value) != {'stage','exceptionCategory','lastEvent'}
            or type(value['stage']) is not str or value['stage'] not in FAILURE_STAGES
            or type(value['exceptionCategory']) is not str or value['exceptionCategory'] not in EXCEPTION_HINTS
            or type(value['lastEvent']) is not str or value['lastEvent'] not in EVENT_TYPES):
        raise ValueError('closed demo failure diagnostic required')


def validate_demo_task_failure(exit_code, output):
    """Failure diagnostics only. Never parses or returns a source candidate."""
    if type(exit_code) is not int or exit_code != 1:
        raise ValueError('actual failed task exit required')
    if (type(output) is not bytes or not 1 <= len(output) <= MAX_DEMO_TASK_RESULT
            or not output.isascii()):
        raise ValueError('bounded failed task packet required')
    value = strict_json(output)
    keys = {'kind','collected','artifactBase64','modelInvocations','assistantCount','resultCount',
            'thinkingCount','normalProviderEnd','providerIteratorClosed','aborted',
            'servedModelVerified','failureDiagnostic'}
    if (type(value) is not dict or set(value) != keys or value['kind'] != 'supervised-demo-v1'
            or value['collected'] is not False or value['artifactBase64'] is not None
            or value['servedModelVerified'] is not False
            or any(type(value[key]) is not bool for key in
                   ['normalProviderEnd','providerIteratorClosed','aborted'])):
        raise ValueError('closed failed demo task packet required')
    validate_failure_statistics(value, value['failureDiagnostic'])
    return value


def validate_failure_statistics(value, diagnostic):
    validate_failure_diagnostic(diagnostic)
    for key,bound in [('modelInvocations',1),('assistantCount',2),('resultCount',2),('thinkingCount',65)]:
        if type(value[key]) is not int or not 0 <= value[key] <= bound:
            raise ValueError('failed task counter rejected')
    if sum(value[key] for key in ['assistantCount','resultCount','thinkingCount']) > 65:
        raise ValueError('failed task total counter rejected')
    if value['normalProviderEnd'] and not value['providerIteratorClosed']:
        raise ValueError('normal task end requires closed iterator')
    event_count={'assistant':'assistantCount','result':'resultCount','thinking':'thinkingCount'}
    if diagnostic['lastEvent'] in event_count and not value[event_count[diagnostic['lastEvent']]]:
        raise ValueError('last event requires positive counter')
    if diagnostic['stage'] in ['input','policy','provider_initialization'] and value['modelInvocations'] != 0:
        raise ValueError('entry failure cannot invoke model')
    if diagnostic['stage'] in ['stream','finalization'] and value['modelInvocations'] != 1:
        raise ValueError('stream failure requires invocation')
    if value['modelInvocations'] == 0 and (any(value[key] for key in
            ['assistantCount','resultCount','thinkingCount','normalProviderEnd','providerIteratorClosed'])
            or diagnostic['lastEvent'] != 'none'):
        raise ValueError('contradictory unstarted task packet')


def validate_demo_task_result(exit_code, output, *, prepared, expected_binding):
    if type(exit_code) is not int or exit_code != 0:
        raise ValueError('normal demo task exit required')
    if type(output) is not bytes or not 1 <= len(output) <= MAX_DEMO_TASK_RESULT or not output.isascii():
        raise ValueError('bounded demo task packet required')
    result = strict_json(output)
    if type(result) is not dict:
        raise ValueError('demo task object required')
    thinking = result.get('thinkingCount')
    encoded = result.get('artifactBase64')
    if type(thinking) is not int or not 0 <= thinking <= 62:
        raise ValueError('demo thinking count rejected')
    if type(encoded) is not str or not 1 <= len(encoded) <= 87384:
        raise ValueError('demo artifact encoding bound rejected')
    expected = {'kind': 'supervised-demo-v1', 'collected': True, 'artifactBase64': encoded,
        'modelInvocations': 1, 'assistantCount': 1, 'resultCount': 1, 'thinkingCount': thinking,
        'normalProviderEnd': True, 'providerIteratorClosed': True, 'aborted': False,
        'servedModelVerified': False}
    if not exact(result, expected):
        raise ValueError('demo collection evidence rejected')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise ValueError('demo base64 rejected') from None
    if base64.b64encode(raw).decode('ascii') != encoded:
        raise ValueError('canonical demo base64 required')
    return parse_demo_artifact(raw, prepared=prepared, expected_binding=expected_binding)
