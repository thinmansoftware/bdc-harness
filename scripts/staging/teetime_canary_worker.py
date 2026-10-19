"""Pinned-image authenticated preflight and fixed task; sanitized output only."""
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import time

ROOT = Path('/app/scripts/staging')
AUTH = Path('/home/appuser/.codex/auth.json')
ENV = {'HOME': '/home/appuser', 'CODEX_HOME': '/home/appuser/.codex',
       'PATH': '/usr/local/bin:/usr/bin:/bin'}
PREFLIGHT_CHECKS = 0
AUTH_REJECTED = False


def oom_kills():
    try:
        raw = Path('/sys/fs/cgroup/memory.events').read_bytes()
        if len(raw) > 4096:
            return None
        values = dict(line.split() for line in raw.decode('ascii').splitlines())
        value = int(values['oom_kill'])
        return value if value >= 0 else None
    except Exception:
        return None


def bounded_process(argv, timeout, env=ENV, input_bytes=None, *, include_exit_code=False):
    if type(include_exit_code) is not bool:
        raise ValueError('closed worker capture mode required')
    if input_bytes is not None and (type(input_bytes) is not bytes or len(input_bytes)>160000):
        raise ValueError('bounded task input required')
    child = subprocess.Popen(argv, cwd='/workspace', env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                             start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'out')
    selector.register(child.stderr, selectors.EVENT_READ, 'err')
    position=0
    if input_bytes is not None:
        os.set_blocking(child.stdin.fileno(),False)
        selector.register(child.stdin,selectors.EVENT_WRITE,'in')
    output = bytearray()
    total = 0
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError('worker timeout')
            for key, _ in selector.select(.1):
                if key.data=='in':
                    if position<len(input_bytes):
                        position+=os.write(child.stdin.fileno(),input_bytes[position:position+4096])
                    if position==len(input_bytes):
                        selector.unregister(child.stdin);child.stdin.close()
                    continue
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                total += len(chunk)
                if total > 1048576:
                    raise ValueError('worker output bound')
                if key.data == 'out':
                    output.extend(chunk)
        code = child.wait(timeout=max(.1, deadline-time.monotonic()))
        if code and not include_exit_code:
            raise ValueError('worker subprocess failed')
        return (code, bytes(output)) if include_exit_code else bytes(output)
    finally:
        selector.close()
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
        for stream in [child.stdin, child.stdout, child.stderr]:
            if stream is not None:
                stream.close()


def check_config(config):
    for key in ['hooks', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2']:
        assert config['features'][key] is False
    assert config['features']['skip_host_skill_discovery'] is True
    assert config['agents']['enabled'] is False
    assert config['skills']['bundled']['enabled'] is False
    assert config['skills']['include_instructions'] is False
    assert config['default_permissions'] == 'tee-time'
    permission = config['permissions']['tee-time']
    assert permission['extends'] == ':workspace' and permission['network']['enabled'] is False
    assert permission['filesystem'] == {':root': 'deny', ':minimal': 'read', '/app': 'read',
                                        ':slash_tmp': 'deny', ':tmpdir': 'deny', 'glob_scan_max_depth': None}
    assert config['model_provider'] == 'openai' and config['model'] == 'gpt-5.6-sol'
    assert config['approval_policy'] == 'never' and config['web_search'] == 'disabled'
    assert config['notify'] == [] and config['mcp_servers'] == {}
    for key in ['instructions', 'developer_instructions', 'compact_prompt', 'forced_chatgpt_workspace_id']:
        assert not config.get(key)
    assert config.get('chatgpt_base_url') in [None, 'https://chatgpt.com/backend-api/']


def preflight():
    global PREFLIGHT_CHECKS, AUTH_REJECTED
    options = json.loads(bounded_process(['bun', '-e',
        'import {restrictedClientOptions} from "/app/packages/providers/src/codex/restricted-policy.ts";'
        'console.log(JSON.stringify(restrictedClientOptions("teetime-connect-v1")))'], 5))
    binary = options['codexPathOverride']
    assert bounded_process([binary, '--version'], 5).strip() == b'codex-cli 0.153.3'
    argv = [binary, 'app-server', '--stdio', '--strict-config']
    def flatten(value, prefix=''):
        for key, item in value.items():
            path = prefix + '.' + key if prefix else key
            if isinstance(item, dict):
                flatten(item, path)
            else:
                argv.extend(['-c', path + '=' + json.dumps(item, separators=(',', ':'))])
    flatten(options['config'])
    for raw in options['configOverrides']:
        argv.extend(['-c', raw])
    for raw in ['model="gpt-5.6-sol"', 'approval_policy="never"', 'web_search="disabled"']:
        argv.extend(['-c', raw])
    child = subprocess.Popen(argv, cwd='/workspace', env=options['env'], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    buffer = b''
    total = 0
    deadline = time.monotonic() + 35
    def send(identifier, method, params):
        child.stdin.write(json.dumps({'id': identifier, 'method': method, 'params': params}).encode()+b'\n')
        child.stdin.flush()
    requests = [
        ('config/read', {'cwd': '/workspace', 'includeLayers': False}),
        ('mcpServerStatus/list', {}),
        ('plugin/list', {'cwds': ['/workspace'], 'forceRefetch': False}),
        ('skills/list', {'cwds': ['/workspace']}),
        ('account/read', {'refreshToken': False}),
        ('account/rateLimits/read', {}),
    ]
    expected = 1
    try:
        send(1, 'initialize', {'clientInfo': {'name': 'teetime_canary', 'version': '1'},
                               'capabilities': {'experimentalApi': True}})
        while time.monotonic() < deadline:
            if not selector.select(.1):
                assert child.poll() is None
                continue
            chunk = os.read(child.stdout.fileno(), 65536)
            assert chunk
            total += len(chunk)
            assert total <= 1048576
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                if not line.strip():
                    continue
                response = json.loads(line)
                if 'id' not in response:
                    assert 'error' not in response
                    continue
                assert response['id'] == expected
                if expected == 7 and 'error' in response:
                    text = str(response['error'].get('message', '')).lower()
                    AUTH_REJECTED = '401' in text or 'unauthorized' in text
                assert 'error' not in response
                result = response['result']
                if expected == 1:
                    child.stdin.write(b'{"method":"initialized"}\n'); child.stdin.flush()
                elif expected == 2:
                    check_config(result['config'])
                elif expected == 3:
                    assert result['data'] == [] and result['nextCursor'] is None
                elif expected == 4:
                    assert result['marketplaces'] == [] and result['marketplaceLoadErrors'] == []
                    assert result['featuredPluginIds'] == []
                elif expected == 5:
                    assert len(result['data']) == 1
                    item = result['data'][0]
                    assert item['cwd'] == '/workspace' and item['skills'] == [] and item['errors'] == []
                elif expected == 6:
                    assert result['account']['type'] == 'chatgpt'
                    assert result['requiresOpenaiAuth'] is True
                elif expected == 7:
                    assert isinstance(result.get('rateLimits'), dict)
                    PREFLIGHT_CHECKS = 6
                    return
                if expected > 1:
                    PREFLIGHT_CHECKS = expected-1
                method, params = requests[expected-1]
                expected += 1
                send(expected, method, params)
        raise TimeoutError('preflight timeout')
    finally:
        selector.close()
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)


def main():
    result = {'passed': False, 'preflightPassed': False, 'authUnchanged': False,
              'artifactVerified': False, 'modelInvocations': 0, 'servedModelVerified': False,
              'taskFailureCode': 'not_started', 'terminalCount': 0, 'systemCategory': 'none',
              'diagnosticHint': 'none', 'artifactExists': False, 'artifactRegular': False,
              'artifactExactContent': False, 'workspaceEntriesExact': False,
              'exceptionCategory': 'none', 'aborted': False, 'elapsedMs': 0, 'oomKillDelta': None,
              'taskDiagnosticsPresent': False}
    original = None
    before_oom = oom_kills()
    try:
        assert __debug__ and os.getuid() == 1001 and Path.cwd() == Path('/workspace')
        assert not AUTH.is_symlink() and stat.S_ISREG(AUTH.lstat().st_mode)
        original = AUTH.read_bytes()
        assert len(original) <= 65536
        assert set(p.name for p in Path('/workspace').iterdir()) == {'.codex', '.agents'}
        for path in ['/etc/codex', '/.codex', '/.agents']:
            assert not Path(path).exists()
        preflight()
        assert AUTH.read_bytes() == original
        result['preflightPassed'] = True
        result['modelInvocations'] = 1
        result['taskFailureCode'] = 'worker_error'
        raw = bounded_process(['bun', str(ROOT/'teetime-canary-task.ts')], 100)
        task = json.loads(raw)
        assert set(task) == {'passed','modelInvocations','servedModelVerified','failureCode','terminalCount','systemCategory','diagnosticHint','exceptionCategory','aborted','elapsedMs'}
        assert type(task['passed']) is bool and task['modelInvocations'] == 1 and task['servedModelVerified'] is False
        assert task['failureCode'] in ['none','unexpected_system','terminal_rejected','provider_failed']
        assert type(task['terminalCount']) is int and task['terminalCount'] in [0,1]
        assert task['systemCategory'] in ['none','task_list','file_change_failed','file_change_unexpected','format_warning','resume_warning','failback','other']
        assert task['diagnosticHint'] in ['none','permission_hint','sandbox_hint','other']
        assert task['exceptionCategory'] in ['none','aborted','auth_hint','quota_hint','model_access_hint','transport_hint','process_hint','other']
        assert type(task['aborted']) is bool
        assert type(task['elapsedMs']) is int and 0 <= task['elapsedMs'] <= 120000
        result['taskDiagnosticsPresent'] = True
        result['taskFailureCode'] = task['failureCode']
        for key in ['terminalCount','systemCategory','diagnosticHint','exceptionCategory','aborted','elapsedMs']:
            result[key] = task[key]
        result['passed'] = task['passed'] and task['failureCode'] == 'none' and not task['aborted'] and task['exceptionCategory'] == 'none'
    except BaseException:
        result['passed'] = False
    finally:
        after_oom = oom_kills()
        if before_oom is not None and after_oom is not None and after_oom >= before_oom:
            result['oomKillDelta'] = after_oom-before_oom
            if result['oomKillDelta']:
                result['passed'] = False
        # Trusted verification runs on failures too; a file alone never grants success.
        try:
            artifact = Path('/workspace/canary.txt')
            result['artifactExists'] = artifact.exists()
            result['artifactRegular'] = stat.S_ISREG(artifact.lstat().st_mode)
            result['artifactExactContent'] = result['artifactRegular'] and artifact.stat().st_size == 22 and artifact.read_bytes() == b'tee-time-canary-ready\n'
            result['workspaceEntriesExact'] = set(p.name for p in Path('/workspace').iterdir()) == {'.codex','.agents','canary.txt'}
            result['artifactVerified'] = (
                result['artifactRegular'] and result['artifactExactContent'] and result['workspaceEntriesExact'])
        except Exception:
            result['artifactVerified'] = False
        try:
            result['authUnchanged'] = original is not None and AUTH.read_bytes() == original
        except Exception:
            result['authUnchanged'] = False
        result['passed'] = result['passed'] and result['authUnchanged'] and result['artifactVerified']
        result['preflightChecks'] = PREFLIGHT_CHECKS
        result['authenticationRejected'] = AUTH_REJECTED
        print(json.dumps(result), flush=True)
    return 0 if result['passed'] else 1


def artifact_workspace_snapshot():
    root = Path('/workspace')
    entries = sorted(root.iterdir(), key=lambda path: path.name)
    if [path.name for path in entries] != ['.agents', '.codex']:
        raise ValueError('artifact workspace inventory rejected')
    records = []
    for path in entries:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or list(path.iterdir()):
            raise ValueError('artifact workspace mask rejected')
        records.append((path.name, info.st_mode, info.st_uid, info.st_gid, info.st_dev, info.st_ino))
    return tuple(records)


def artifact_main(nonce, source, execution=None):
    import hashlib
    import sys
    # Python -I excludes the script directory. Only the immutable image source is added.
    sys.path.insert(0, str(ROOT))
    from teetime_auth_artifact_protocol import empty_worker_result, validate_selector, validate_worker_result
    from teetime_fixed_artifact import validate_task_result, validate_wrapper_evidence
    validate_selector('artifact', source, nonce)
    if os.environ.get('TEETIME_AUTH_ARTIFACT_SOURCE_SHA') != source:
        raise ValueError('artifact image source rejected')
    result = empty_worker_result(demo=execution is not None)
    original = before_workspace = candidate = task = None
    policy_hash = None
    worker_started=time.monotonic() if execution is not None else None
    worker_deadline=worker_started+630 if execution is not None else None
    before_oom = oom_kills()
    started = worker_started
    try:
        assert __debug__ and os.getuid() == 1001 and Path.cwd() == Path('/workspace')
        info = AUTH.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_uid == 1001 and info.st_mode & 0o777 == 0o600
        assert 1 <= info.st_size <= 65536
        original = AUTH.read_bytes()
        before_workspace = artifact_workspace_snapshot()
        for path in ['/etc/codex', '/.codex', '/.agents']:
            assert not Path(path).exists()
        preflight()
        assert AUTH.read_bytes() == original
        assert artifact_workspace_snapshot() == before_workspace
        result['preflightPassed'] = True
        policy_hash = hashlib.sha256(Path('/app/packages/providers/src/codex/restricted-policy.ts').read_bytes()).hexdigest()
        if execution is not None:
            if execution.source!=source or execution.binding['policyHash']!='sha256:'+policy_hash:
                raise ValueError('demo worker source or policy differs')
            task_budget=worker_deadline-time.monotonic()-5
            # Preserve the complete query allowance plus initialization and
            # iterator shutdown. Never silently shorten an admitted query.
            if task_budget<610:
                raise ValueError('insufficient complete demo query budget')
        result['taskStarted'] = True
        result['modelInvocations'] = None  # Unknown until a valid task receipt arrives.
        if execution is None: started = time.monotonic()
        if execution is None:
            raw = bounded_process(['bun', str(ROOT/'teetime-fixed-artifact-task.ts'), nonce], 100)
            candidate = validate_task_result(0, raw, nonce=nonce, policy_hash=policy_hash)
        else:
            from teetime_demo_execution import task_input,DEMO_LIMITS
            from teetime_demo_result import validate_demo_task_result, validate_demo_task_failure
            code,raw=bounded_process(['bun',str(ROOT/'teetime-demo-task-entry.ts')],
                task_budget,input_bytes=task_input(execution),include_exit_code=True)
            if code == 1:
                task=validate_demo_task_failure(code,raw)
                result['taskFailureDiagnostic']=dict(task['failureDiagnostic'])
            else:
                candidate=validate_demo_task_result(code,raw,prepared=execution.prepared,
                    expected_binding=dict(execution.binding))
        if task is None:
            task = json.loads(raw)  # Strict duplicate/schema validation already succeeded.
        result['taskDiagnosticsPresent'] = True
        for key in ['modelInvocations', 'assistantCount', 'resultCount', 'thinkingCount',
                    'normalProviderEnd', 'providerIteratorClosed', 'aborted']:
            result[key] = task[key]
    except BaseException:
        result['failureCategory'] = 'rejected'
    finally:
        if started is not None:
            result['elapsedMs'] = max(0, int((time.monotonic()-started)*1000))
        after_oom = oom_kills()
        if before_oom is not None and after_oom is not None and after_oom >= before_oom:
            result['oomKillDelta'] = after_oom-before_oom
        try:
            info = AUTH.lstat()
            result['authUnchanged'] = (original is not None and stat.S_ISREG(info.st_mode)
                and info.st_uid == 1001 and info.st_mode & 0o777 == 0o600 and AUTH.read_bytes() == original)
            result['workspaceUnchanged'] = (before_workspace is not None
                and artifact_workspace_snapshot() == before_workspace)
        except Exception:
            pass
        if execution is not None:
            from teetime_artifact_workspace import workspace_diagnostic
            result['workspaceDiagnostic'] = workspace_diagnostic(Path('/workspace'), before_workspace, os.getuid())
        result['preflightChecks'] = PREFLIGHT_CHECKS
        result['authenticationRejected'] = AUTH_REJECTED
        try:
            if candidate is None or task is None or result['oomKillDelta'] != 0:
                raise ValueError('artifact task not verified')
            validate_wrapper_evidence(auth_before=original, auth_after=AUTH.read_bytes(),
                workspace_unchanged=result['workspaceUnchanged'], preflight_checks=PREFLIGHT_CHECKS)
            if not result['authUnchanged']:
                raise ValueError('artifact auth observation rejected')
            result.update({'passed': True, 'artifactVerified': True, 'failureCategory': 'none',
                'artifactBase64': task['artifactBase64'], 'artifactHash': candidate.artifact_hash,
                'bindingHash': candidate.binding_hash, 'manifestHash': candidate.manifest_hash,
                'sourceTree': candidate.source_tree})
            validate_worker_result(result, nonce=nonce, policy_hash=policy_hash,execution=execution)
        except Exception:
            result.update({'passed': False, 'artifactVerified': False, 'artifactBase64': None,
                'artifactHash': None, 'bindingHash': None, 'manifestHash': None, 'sourceTree': None,
                'failureCategory': 'rejected'})
        print(json.dumps(result), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    import argparse
    import re
    parser = argparse.ArgumentParser()
    parser.add_argument('--task', choices=['filesystem', 'artifact', 'supervised-demo'], default='filesystem')
    parser.add_argument('--nonce')
    parser.add_argument('--artifact-source')
    parser.add_argument('--demo-package-hash')
    args = parser.parse_args()
    if args.task == 'filesystem':
        if args.nonce is not None or args.artifact_source is not None or args.demo_package_hash is not None:
            parser.error('artifact-only arguments rejected in filesystem mode')
        raise SystemExit(main())
    if (re.fullmatch('[a-f0-9]{32}', args.nonce or '') is None
            or re.fullmatch('[a-f0-9]{40}', args.artifact_source or '') is None):
        parser.error('artifact mode requires exact nonce and source')
    execution=None
    if args.task=='supervised-demo':
        import sys
        sys.path.insert(0,str(ROOT))
        from teetime_demo_execution import parse_demo_execution,MAX_EXECUTION_BYTES
        execution=parse_demo_execution(sys.stdin.buffer.read(MAX_EXECUTION_BYTES+1),args.demo_package_hash)
        if execution.source!=args.artifact_source: parser.error('demo source differs')
    elif args.demo_package_hash is not None:
        parser.error('demo-only package hash rejected')
    raise SystemExit(artifact_main(args.nonce, args.artifact_source,execution))
