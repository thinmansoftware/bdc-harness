"""Independent closed diagnostic worker validator; never app acceptance."""
import json
import re
from teetime_joined_fixture import strict_json
from teetime_minimal_diagnostic import validate_minimal_diagnostic, validate_minimal_diagnostic_v2

KEYS = {'version', 'kind', 'nonce', 'source', 'passed', 'preflightPassed', 'preflightChecks',
        'authenticationRejected', 'authUnchanged', 'workspaceUnchanged', 'taskStarted',
        'taskProcessReaped', 'taskExitCode', 'taskReceipt', 'oomKillDelta', 'elapsedMs', 'failureCategory'}
BOOLS = {'passed', 'preflightPassed', 'authenticationRejected', 'authUnchanged',
         'workspaceUnchanged', 'taskStarted', 'taskProcessReaped'}


def validate_minimal_worker(exit_code, raw, *, nonce, source):
    return _validate_worker(exit_code, raw, nonce=nonce, source=source, version=1)


def validate_minimal_worker_v2(exit_code, raw, *, nonce, source):
    """Explicit source-only v2 schema; no worker entry selects it yet."""
    return _validate_worker(exit_code, raw, nonce=nonce, source=source, version=2)


def _validate_worker(exit_code, raw, *, nonce, source, version):
    if (type(nonce) is not str or re.fullmatch('[a-f0-9]{32}', nonce) is None
            or type(source) is not str or re.fullmatch('[a-f0-9]{40}', source) is None
            or type(exit_code) is not int or exit_code not in (0, 1)
            or type(raw) is not bytes or not 1 <= len(raw) <= 8192 or not raw.isascii()):
        raise ValueError('bounded worker identity and receipt required')
    data = strict_json(raw)
    if (type(data) is not dict or set(data) != KEYS or type(data['version']) is not int
            or data['version'] != version or data['kind'] != 'teetime-minimal-worker'
            or data['nonce'] != nonce or data['source'] != source
            or any(type(data[key]) is not bool for key in BOOLS)
            or type(data['failureCategory']) is not str
            or data['failureCategory'] not in {'none', 'preflight', 'task', 'cleanup'}):
        raise ValueError('closed worker schema required')
    for key, bound in [('preflightChecks', 6), ('elapsedMs', 180000)]:
        if type(data[key]) is not int or not 0 <= data[key] <= bound:
            raise ValueError('worker counter bound')
    oom, task_exit, task = data['oomKillDelta'], data['taskExitCode'], data['taskReceipt']
    if oom is not None and (type(oom) is not int or not 0 <= oom <= 10**9):
        raise ValueError('worker OOM bound')
    if task_exit is not None and (type(task_exit) is not int or task_exit not in (0, 1)):
        raise ValueError('worker child exit bound')
    if data['preflightPassed'] and (data['preflightChecks'] != 6 or data['authenticationRejected']):
        raise ValueError('worker preflight contradiction')
    if data['authenticationRejected'] and data['preflightChecks'] == 6:
        raise ValueError('worker authentication contradiction')
    if data['taskStarted'] and not data['preflightPassed']:
        raise ValueError('worker task before preflight')
    if data['taskProcessReaped'] and not data['taskStarted']:
        raise ValueError('worker reaping before capture')
    if task_exit is not None and not data['taskProcessReaped']:
        raise ValueError('worker exit before reaping')
    if task is not None:
        if not (data['taskStarted'] and data['taskProcessReaped'] and data['preflightPassed']) or task_exit is None:
            raise ValueError('worker child receipt without observations')
        validator = validate_minimal_diagnostic if version == 1 else validate_minimal_diagnostic_v2
        validator(task_exit, json.dumps(task, ensure_ascii=True).encode('ascii'))
    clean = data['authUnchanged'] and data['workspaceUnchanged'] and oom == 0
    success = clean and data['preflightPassed'] and task is not None and task['passed']
    if data['passed'] != success or (exit_code == 0) != success:
        raise ValueError('worker success contradiction')
    category = data['failureCategory']
    if success:
        if category != 'none': raise ValueError('worker successful failure category')
    elif category == 'none':
        raise ValueError('worker missing failure category')
    elif category == 'task' and (not data['taskStarted'] or not clean):
        raise ValueError('worker task failure contradiction')
    elif category == 'preflight' and (data['taskStarted'] or data['preflightPassed']):
        raise ValueError('worker preflight failure after capture')
    elif category == 'cleanup' and clean:
        raise ValueError('worker cleanup failure without observation')
    return data
