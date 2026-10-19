"""Validate collected demo bytes. Does not establish approval or wrapper custody."""
import base64

from teetime_demo_case import parse_demo_artifact
from teetime_joined_fixture import exact, strict_json

# 65536 artifact bytes expand to 87384 base64 bytes, plus bounded metadata.
MAX_DEMO_TASK_RESULT = 90112


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
