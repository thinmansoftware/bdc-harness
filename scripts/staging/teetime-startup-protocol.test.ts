import { expect, test } from 'bun:test';
import { StartupProtocol, startupArguments, exchangeStartup, startupCommandOutput } from './teetime-startup-protocol';
const childEnv = process.platform === 'win32' && process.env.SystemRoot
  ? { SystemRoot: process.env.SystemRoot } : {};

test('successful bounded synchronous child accepts absent no-signal field', () => {
  // Harmless local Bun child only: no Codex executable, account, socket or query.
  const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', 'process.stdout.write("ready")'], {
    env: childEnv,
    stdout: 'pipe', stderr: 'pipe', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 4096,
  });
  expect(child.success).toBe(true);
  expect(child.exitCode).toBe(0);
  expect(startupCommandOutput(child, 4096)).toEqual(Buffer.from('ready'));
});

test('startup command guard still rejects failure, signals, overflow and timeout', () => {
  const good = { success: true, exitCode: 0, signalCode: null,
    stdout: Buffer.from('ready'), stderr: Buffer.alloc(0) };
  expect(startupCommandOutput({ ...good, signalCode: null }, 4096)).toEqual(good.stdout);
  for (const change of [
    { success: false }, { exitCode: 1 }, { signalCode: 'SIGKILL' }, { signalCode: '' },
    { exitedDueToTimeout: true }, { exitedDueToMaxBuffer: true },
    { stdout: Buffer.alloc(4097) }, { stderr: Buffer.alloc(4096) },
  ]) expect(() => startupCommandOutput({ ...good, ...change }, 4096)).toThrow('startup command rejected');
  const timedOut = Bun.spawnSync([process.execPath, '--no-env-file', '-e', 'setTimeout(() => {}, 10000)'], {
    env: childEnv,
    stdout: 'pipe', stderr: 'pipe', timeout: 50, killSignal: 'SIGKILL', maxBuffer: 4096,
  });
  expect(() => startupCommandOutput(timedOut, 4096)).toThrow('startup command rejected');
});

test('exchange exposes only its current fixed boundary on synthetic failures', async () => {
  for (const failAt of ['initialize-exchange', 'thread-start-exchange']) {
    const phases: string[] = [], sent: string[] = [];
    async function* output(): AsyncGenerator<Uint8Array> {
      if (failAt === 'thread-start-exchange')
        yield Buffer.from(JSON.stringify({ id: 1, result: initialized }) + '\n');
      throw new Error('PRIVATE-STREAM-TEXT');
    }
    let killed = false;
    await expect(exchangeStartup({
      stdout: output(), stderr: (async function* () {})(), exited: Promise.resolve(1),
      write: line => { sent.push(JSON.parse(line).method); }, kill: () => { killed = true; },
    }, 1000, phase => { phases.push(phase); })).rejects.toThrow('startup exchange rejected');
    expect(killed).toBe(true);
    expect(phases.at(-1)).toBe(failAt);
    expect(phases).not.toContain('PRIVATE-STREAM-TEXT');
    expect(sent).not.toContain('turn/start');
  }
});

test('a complete synthetic RPC response cannot succeed when owned reaping is uncertain', async () => {
  const exited = Promise.reject(new Error('PRIVATE-REAP-FAILURE'));
  void exited.catch(() => {});
  let accepted = false, kills = 0;
  async function* output(): AsyncGenerator<Uint8Array> {
    yield Buffer.from(JSON.stringify({ id: 1, result: initialized }) + '\n');
    yield Buffer.from('{"id":2,"result":{"thread":{"id":"synthetic"}}}\n');
  }
  try {
    await exchangeStartup({ stdout: output(), stderr: (async function* () {})(), exited,
      write: () => {}, kill: () => { kills++; } }, 1000);
    accepted = true;
  } catch { /* No raw cleanup error is published. */ }
  expect(accepted).toBe(false);
  expect(kills).toBeGreaterThan(0);
});

const initialized = {
  userAgent: 'codex_exec/0.153.3 (Linux synthetic; x86_64) (codex_exec; 0.153.3)',
  codexHome: '/home/appuser/.codex',
  platformFamily: 'unix',
  platformOs: 'linux',
};

test('only initialize, initialized and one thread/start can be emitted', () => {
  const protocol = new StartupProtocol();
  expect(protocol.begin()).toEqual({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'codex_exec', title: null, version: '0.153.3' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: null,
      },
    },
  });
  expect(() => protocol.begin()).toThrow();
  const messages = protocol.accept({ id: 1, result: initialized });
  expect(messages.map(value => value.method)).toEqual(['initialized', 'thread/start']);
  expect(messages[1]).toEqual({
    id: 2,
    method: 'thread/start',
    params: {
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      cwd: '/workspace',
      runtimeWorkspaceRoots: ['/workspace'],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: null,
      permissions: 'tee-time',
      config: null,
      serviceName: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      multiAgentMode: null,
      ephemeral: false,
      historyMode: 'paginated',
      sessionStartSource: null,
      threadSource: 'user',
      projectId: null,
      environments: null,
      dynamicTools: null,
      selectedCapabilityRoots: null,
      mockExperimentalField: null,
    },
  });
  expect(
    protocol.accept({
      id: 2,
      error: { code: -32603, message: 'private', data: { nested: 'private' } },
    })
  ).toEqual([]);
  expect(protocol.outcome()).toEqual({
    threadCreated: false,
    rpcError: { code: -32603, message: 'private', data: { nested: 'private' } },
  });
  expect(() => protocol.accept({ id: 2, result: { thread: { id: 'duplicate' } } })).toThrow();
});

test('accepts a created thread as diagnostic state without a turn or approval', () => {
  const protocol = new StartupProtocol();
  protocol.begin();
  protocol.accept({ id: 1, result: initialized });
  expect(
    protocol.accept({ method: 'thread/started', params: { thread: { id: 'synthetic' } } })
  ).toEqual([]);
  protocol.accept({ id: 2, result: { thread: { id: 'synthetic' } } });
  expect(protocol.outcome()).toEqual({ threadCreated: true, rpcError: null });
  expect(protocol.outcome()).not.toHaveProperty('passed');
});

test('never retries initialization/history errors and rejects invalid response framing', () => {
  for (const response of [
    { id: 1, error: { code: -32600, message: 'unsupported history' } },
    { id: 2, result: {} },
    { id: 1, result: {}, error: { code: 1, message: 'bad' } },
    { id: 1, result: {}, extra: true },
    { id: 1, method: 'turn/start', params: {} },
    null,
  ]) {
    const protocol = new StartupProtocol();
    protocol.begin();
    expect(() => protocol.accept(response)).toThrow();
    expect(() => protocol.outcome()).toThrow();
  }
  const protocol = new StartupProtocol();
  protocol.begin();
  protocol.accept({ id: 1, result: initialized });
  expect(() => protocol.accept({ method: 'item/started', params: {} })).toThrow();
  expect(() => protocol.accept({ id: 2, result: {} })).toThrow();
});

test('native argument construction retains restricted settings and disables search', () => {
  const args = startupArguments();
  expect(args.slice(1, 4)).toEqual(['app-server', '--stdio', '--strict-config']);
  expect(args.join(' ')).toContain('permissions.tee-time.filesystem=');
  expect(args.join(' ')).toContain('web_search="disabled"');
  expect(args.join(' ')).toContain(
    'model_catalog_json="/home/appuser/.codex/reviewer-models.json"'
  );
  expect(args.join(' ')).not.toContain('danger-full-access');
  expect(args).not.toContain('exec');
});

test('exchange captures private error without sending any turn and always reaps its child', async () => {
  const sent: object[] = [];
  let killed = false;
  let reap!: (value: number) => void;
  const exited = new Promise<number>(resolve => {
    reap = resolve;
  });
  async function* stdout(): AsyncGenerator<Uint8Array> {
    yield Buffer.from(JSON.stringify({ id: 1, result: initialized }) + '\n');
    yield Buffer.from('{"id":2,"error":{"code":-32603,"message":"private"}}\n');
  }
  async function* stderr(): AsyncGenerator<Uint8Array> {
    yield Buffer.from('not published');
  }
  const result = await exchangeStartup(
    {
      stdout: stdout(),
      stderr: stderr(),
      exited,
      write: value => {
        sent.push(JSON.parse(value));
      },
      kill: () => {
        killed = true;
        reap(137);
      },
    },
    1000
  );
  expect(killed).toBe(true);
  expect(result).toEqual({ threadCreated: false, rpcError: { code: -32603, message: 'private' } });
  expect(sent.map(value => (value as { method: string }).method)).toEqual([
    'initialize',
    'initialized',
    'thread/start',
  ]);
});

test('mismatched or incomplete server identity prevents thread/start', () => {
  for (const result of [
    {},
    { ...initialized, platformOs: 'windows' },
    { ...initialized, codexHome: '/inherited' },
    { ...initialized, userAgent: 'codex_exec/0.153.2 (old)' },
    { ...initialized, extra: 'unknown' },
  ]) {
    const protocol = new StartupProtocol();
    protocol.begin();
    expect(() => protocol.accept({ id: 1, result })).toThrow();
  }
});

test('exchange rejects overflow, partial UTF8 and truncated protocol without exposing child text', async () => {
  for (const chunks of [
    [Buffer.alloc(65537, 120)],
    [Buffer.from([255])],
    [Buffer.from('{"id":1,"result":{}}\n{"id":2')],
  ]) {
    let killed = false;
    async function* stdout(): AsyncGenerator<Uint8Array> {
      yield* chunks;
    }
    async function* stderr(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('PRIVATE-RAW');
    }
    try {
      await exchangeStartup(
        {
          stdout: stdout(),
          stderr: stderr(),
          exited: Promise.resolve(1),
          write: () => {},
          kill: () => {
            killed = true;
          },
        },
        1000
      );
      throw new Error('unexpected acceptance');
    } catch (error) {
      expect(String(error)).toBe('Error: startup exchange rejected');
    }
    expect(killed).toBe(true);
  }
});

test('exchange times out without retry and reaps the owned process', async () => {
  let reap!: (value: number) => void;
  let release!: () => void;
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  const exited = new Promise<number>(resolve => {
    reap = resolve;
  });
  const sent: string[] = [];
  async function* stream(): AsyncGenerator<Uint8Array> {
    await wait;
  }
  await expect(
    exchangeStartup(
      {
        stdout: stream(),
        stderr: stream(),
        exited,
        write: line => {
          sent.push(line);
        },
        kill: () => {
          reap(137);
          release();
        },
      },
      20
    )
  ).rejects.toThrow('startup exchange rejected');
  expect(sent).toHaveLength(1);
});
