"""Reviewed offline fixture only; never an authenticated canary entrypoint.

Requires an owned network-none, read-only container with an empty tmpfs /tmp.
Uses synthetic API credentials and a loopback rejecting mock. No TLS termination,
upstream dialing, real account files, model response or booking is possible.
"""
import asyncio
from collections import Counter
import json
import hashlib
import os
from pathlib import Path
import signal
import tempfile
import subprocess

from teetime_connect_proxy import parse_connect, ConnectPolicyError, HEADER_LIMIT


SDK_PROGRAM = r'''
import { Codex } from '/app/node_modules/@openai/codex-sdk/dist/index.js';
const env = {HOME: process.env.FIXTURE_HOME, CODEX_HOME: process.env.FIXTURE_HOME + '/.codex',
  PATH: '/usr/local/bin:/usr/bin:/bin', HTTPS_PROXY: process.env.FIXTURE_PROXY,
  HTTP_PROXY: process.env.FIXTURE_PROXY};
const sdk = new Codex({
  codexPathOverride: '/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
  baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: 'synthetic-offline-fixture-only', env,
  config: {notify: [], model_provider: 'openai',
    features: {hooks: false, apps: false, plugins: false, remote_plugin: false,
      multi_agent: false, multi_agent_v2: false, skip_host_skill_discovery: true},
    skills: {bundled: {enabled: false}, include_instructions: false}}
});
const control = new AbortController();
const timer = setTimeout(() => control.abort(), 6000);
let events = 0, completed = false, caught = false;
try {
  const thread = sdk.startThread({model: 'gpt-5.6-sol', workingDirectory: process.env.FIXTURE_HOME,
    skipGitRepoCheck: true, approvalPolicy: 'never', sandboxMode: 'read-only',
    webSearchMode: 'disabled', networkAccessEnabled: false});
  const stream = await thread.runStreamed('Synthetic offline transport fixture. Do not call tools.',
    {signal: control.signal});
  for await (const event of stream.events) {
    events++;
    if (events > 32) {control.abort(); break;}
    if (event.type === 'turn.completed') completed = true;
  }
} catch { caught = true; }
finally { clearTimeout(timer); }
console.log(JSON.stringify({events, completed, caught, aborted: control.signal.aborted}));
'''


async def main():
    if (os.getuid() != 1001 or os.environ.get('TEETIME_OFFLINE_NATIVE_FIXTURE') != 'rejecting-loopback-v1'
            or Path('/tmp').is_symlink()):
        raise ValueError('owned offline fixture container required')
    binary = Path('/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex')
    sdk = Path('/app/node_modules/@openai/codex-sdk')
    version = subprocess.run([str(binary), '--version'], env={'PATH': '/usr/bin:/bin'},
                             capture_output=True, timeout=3, check=True)
    if (version.stdout.strip() != b'codex-cli 0.153.3'
            or json.loads((sdk/'package.json').read_bytes())['version'] != '0.153.3'
            or Path('/home/appuser/.codex/auth.json').exists()):
        raise ValueError('pinned offline native dependencies required')
    measured = {}
    for key, path in [('binary', binary), ('sdkEntry', sdk/'dist/index.js'),
                      ('sdkPackage', sdk/'package.json')]:
        with path.open('rb') as handle:
            measured[key] = hashlib.file_digest(handle, 'sha256').hexdigest()
    counts = Counter()
    tasks = set()
    connections = 0
    classified = 0
    payload = None

    async def reject(reader, writer):
        nonlocal connections, classified
        task = asyncio.current_task()
        tasks.add(task)
        try:
            if connections >= 32:
                counts['connection_bound'] = 1
                return
            connections += 1
            async with asyncio.timeout(2):
                data = await reader.readuntil(b'\r\n\r\n')
            try:
                parse_connect(data)
                counts['policy_accepted_mock_rejected'] += 1
            except ConnectPolicyError as error:
                counts[error.reason] += 1
            classified += 1
            writer.write(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            await writer.drain()
        except (TimeoutError, asyncio.LimitOverrunError, asyncio.IncompleteReadError, OSError):
            counts['incomplete_or_bounded'] += 1
        finally:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 1)
            except (TimeoutError, OSError):
                pass
            tasks.discard(task)

    server = await asyncio.start_server(reject, '127.0.0.1', 0, limit=HEADER_LIMIT)
    try:
        with tempfile.TemporaryDirectory(prefix='teetime-native-', dir='/tmp') as home:
            Path(home, '.codex').mkdir()
            child = await asyncio.create_subprocess_exec('bun', '-e', SDK_PROGRAM,
                cwd=home, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': home,
                    'FIXTURE_HOME': home,
                    'FIXTURE_PROXY': 'http://127.0.0.1:'+str(server.sockets[0].getsockname()[1])},
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, start_new_session=True, limit=131072)
            async def bounded_read(stream, maximum):
                data = bytearray()
                while True:
                    part = await stream.read(min(4096, maximum+1-len(data)))
                    if not part:
                        return bytes(data)
                    data.extend(part)
                    if len(data) > maximum:
                        raise ValueError('synthetic output bound')
            readers = [asyncio.create_task(bounded_read(child.stdout, 4096)),
                       asyncio.create_task(bounded_read(child.stderr, 131072))]
            try:
                stdout, stderr, _ = await asyncio.wait_for(
                    asyncio.gather(*readers, child.wait()), 10)
            except BaseException:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await asyncio.wait_for(child.wait(), 2)
                for reader in readers:
                    reader.cancel()
                await asyncio.wait_for(asyncio.gather(*readers, return_exceptions=True), 2)
                raise
            finally:
                # Also reap any native grandchild left behind by the SDK process.
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if child.returncode != 0 or len(stdout) > 4096 or len(stderr) > 131072:
                raise ValueError('bounded synthetic SDK fixture failed')
            result = json.loads(stdout)
            if (set(result) != {'events', 'completed', 'caught', 'aborted'}
                    or type(result['events']) is not int or not 0 <= result['events'] <= 33
                    or any(type(result[name]) is not bool for name in ['completed','caught','aborted'])
                    or result['completed']):
                raise ValueError('unexpected synthetic SDK output')
            # No raw request/error/model content leaves this process.
            payload = {'kind': 'offline-native-transport-v1', 'accountProvided': False,
                'syntheticApiCredential': True, 'upstreamConnections': 0,
                'productionConfigurationChanged': False, 'childExitCode': child.returncode,
                'childReaped': True, 'native': result,
                'stderrBytesDiscarded': len(stderr), 'dependencySha256': measured,
                'nativeVersion': '0.153.3', 'sdkVersion': '0.153.3'}
    finally:
        server.close()
        await asyncio.wait_for(server.wait_closed(), 1)
        for task in list(tasks):
            task.cancel()
        await asyncio.wait_for(asyncio.gather(*list(tasks), return_exceptions=True), 2)
    if not classified:
        raise ValueError('no classified native CONNECT evidence')
    payload.update({'connectReasons': dict(counts), 'classifiedConnections': classified,
                    'acceptedConnections': connections, 'handlersSettled': not tasks})
    if tasks:
        raise ValueError('native fixture handlers not settled')
    print(json.dumps(payload))


if __name__ == '__main__':
    asyncio.run(main())
