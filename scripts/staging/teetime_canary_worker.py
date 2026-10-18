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


def bounded_process(argv, timeout, env=ENV):
    child = subprocess.Popen(argv, cwd='/workspace', env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'out')
    selector.register(child.stderr, selectors.EVENT_READ, 'err')
    output = bytearray()
    total = 0
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError('worker timeout')
            for key, _ in selector.select(.1):
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
        if code:
            raise ValueError('worker subprocess failed')
        return bytes(output)
    finally:
        selector.close()
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)


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
              'taskFailureCode': 'not_started'}
    original = None
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
        assert set(task) == {'passed','modelInvocations','servedModelVerified','failureCode'}
        assert type(task['passed']) is bool and task['modelInvocations'] == 1 and task['servedModelVerified'] is False
        assert task['failureCode'] in ['none','unexpected_system','terminal_rejected','provider_failed']
        result['taskFailureCode'] = task['failureCode']
        result['passed'] = task['passed'] and task['failureCode'] == 'none'
    except BaseException:
        result['passed'] = False
    finally:
        # Trusted verification runs on failures too; a file alone never grants success.
        try:
            artifact = Path('/workspace/canary.txt')
            result['artifactVerified'] = (
                set(p.name for p in Path('/workspace').iterdir()) == {'.codex','.agents','canary.txt'}
                and stat.S_ISREG(artifact.lstat().st_mode) and artifact.stat().st_size == 22
                and artifact.read_bytes() == b'tee-time-canary-ready\n')
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


if __name__ == '__main__':
    raise SystemExit(main())
