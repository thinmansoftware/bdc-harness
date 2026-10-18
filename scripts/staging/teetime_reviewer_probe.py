"""Closed resource and cleanup helpers for credential-free reviewer fixtures."""
import json
import re
from teetime_artifact_contract import unique_object, reject_constant

CASES = ('positive', 'shell', 'patch', 'code-mode')
FAILURE_PHASES = ('bootstrap','options-import','home','cli-version','catalog-read','catalog-compare',
                  'catalog-write','configuration','server','sdk-import','sdk-run','final-check')
FAILURE_CATEGORIES = ('module-resolution','fixture-input','native-process','catalog-identity',
                      'configuration','request-protocol','sdk-stream','sdk-process','sdk-parse',
                      'case-acceptance','cleanup-failed','other')
EVENT_TYPES = ('thread.started','turn.started','item.started','item.updated','item.completed',
               'turn.completed','turn.failed','error','other')
REJECTIONS = ('none','endpoint','upgrade-limit','wire-bound','decoding','tool-inventory',
              'request-shape','denial-mismatch')
SIGNALS = ('SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGINT','SIGPIPE','SIGBUS','SIGILL')
STDERR_CATEGORIES = ('other','config-overrides','codex-home','exec-policy','config-load','app-server-start')


def validate_failure_evidence(value):
    if (type(value) is not dict or set(value) != {'requests','websocketAttempts','validatedRequests',
                                                'firstRejection','eventCounts','sdkFailure'}):
        raise ValueError('reviewer diagnostic evidence fields')
    for key in ('requests','websocketAttempts','validatedRequests'):
        if type(value[key]) is not int or not 0 <= value[key] <= 255:
            raise ValueError('reviewer diagnostic count bound')
    if value['validatedRequests'] > min(2,value['requests']) or value['firstRejection'] not in REJECTIONS:
        raise ValueError('reviewer diagnostic rejection inventory')
    counts = value['eventCounts']
    if (type(counts) is not dict or any(key not in EVENT_TYPES or type(count) is not int
            or not 0 <= count <= 65 for key,count in counts.items()) or sum(counts.values()) > 65):
        raise ValueError('reviewer diagnostic event inventory')
    failure = value['sdkFailure']
    if (type(failure) is not dict or set(failure) != {'kind','exitCode','signal','stderrCategory'}
            or failure['kind'] not in ('cli-exit','sdk-parse','aborted','other')
            or failure['stderrCategory'] not in STDERR_CATEGORIES):
        raise ValueError('reviewer diagnostic SDK inventory')
    if failure['kind'] == 'cli-exit':
        numeric = type(failure['exitCode']) is int and 0 <= failure['exitCode'] <= 255
        signaled = failure['signal'] in SIGNALS
        if not ((numeric and failure['signal'] is None) or (signaled and failure['exitCode'] is None)):
            raise ValueError('reviewer diagnostic SDK termination')
    elif failure['exitCode'] is not None or failure['signal'] is not None or failure['stderrCategory'] != 'other':
        raise ValueError('reviewer diagnostic SDK classification')


def reviewer_failure_diagnostic(raw, exit_code):
    if (type(exit_code) is not int or not 1 <= exit_code <= 255 or type(raw) is not bytes
            or not 1 <= len(raw) <= 2048 or not raw.isascii() or len(raw.strip().splitlines()) != 1):
        raise ValueError('reviewer failure diagnostic framing')
    try:
        frame = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, RecursionError):
        raise ValueError('reviewer failure diagnostic JSON') from None
    if (type(frame) is not dict or frame.get('kind') not in ('teetime-reviewer-failure-v1','teetime-reviewer-failure-v2')
            or frame.get('phase') not in FAILURE_PHASES or frame.get('category') not in FAILURE_CATEGORIES):
        raise ValueError('reviewer failure diagnostic fields')
    fields = {'kind','phase','category'}
    if frame['kind'] == 'teetime-reviewer-failure-v2': fields.add('evidence')
    if set(frame) != fields: raise ValueError('reviewer failure diagnostic fields')
    if 'evidence' in frame: validate_failure_evidence(frame['evidence'])
    return frame


def reviewer_settings(case, owner):
    if case not in CASES or re.fullmatch(r'teetime-reviewer-[0-9]+-[0-9]+', owner or '') is None:
        raise ValueError('reviewer case or owner rejected')
    return ['--label', 'teetime.reviewer-fixture='+owner,
            '--label', 'teetime.reviewer-case='+case,
            '--env', 'TEE_TIME_REVIEWER_CASE='+case,
            '--pids-limit', '128', '--memory', '768m', '--memory-swap', '768m', '--cpus', '1']


def verify_reviewer_limits(host):
    expected = {'PidsLimit':128, 'Memory':805306368, 'MemorySwap':805306368, 'NanoCpus':1000000000}
    if any(type(host.get(key)) is not int or host[key] != value for key,value in expected.items()):
        raise ValueError('reviewer resource limits mismatch')


def remove_owned_reviewer(docker, name, owner):
    reviewer_settings('positive', owner)
    if re.fullmatch(r'teetime-sandbox-probe-[a-f0-9]{12}', name or '') is None:
        raise ValueError('reviewer cleanup name rejected')
    query = ('container', 'ls', '-aq', '--no-trunc', '--filter', 'name=^/'+name+'$')
    result = docker(*query)
    if result.returncode:
        raise RuntimeError('reviewer cleanup inventory failed')
    if not result.stdout.strip():
        return
    inspected = docker('inspect', name)
    if inspected.returncode or len(inspected.stdout) > 131072:
        raise RuntimeError('reviewer cleanup inspection failed')
    entries = json.loads(inspected.stdout)
    if type(entries) is not list or len(entries) != 1:
        raise ValueError('reviewer cleanup inventory ambiguous')
    data = entries[0]
    identifier = data.get('Id', '')
    if (re.fullmatch('[a-f0-9]{64}', identifier) is None or data.get('Name') != '/'+name
            or data.get('Config',{}).get('Labels',{}).get('teetime.reviewer-fixture') != owner
            or result.stdout.strip() != identifier):
        raise ValueError('reviewer cleanup ownership mismatch')
    if docker('rm', '-f', identifier).returncode:
        raise RuntimeError('reviewer owned removal failed')
    for check in [query, ('container','ls','-aq','--no-trunc','--filter','id='+identifier)]:
        absent = docker(*check)
        if absent.returncode or absent.stdout.strip():
            raise RuntimeError('reviewer removal absence unverified')
