// Pure non-query diagnostic protocol. No SDK, native process, network or registration.
import { fixtureClientOptions, parseUniqueFixtureJson } from './teetime-reviewer-fixture';
import { RESTRICTED_BINARY } from '../../packages/providers/src/codex/restricted-policy';

interface Message {
  method: string;
  id?: number;
  params?: Record<string, unknown>;
}
interface Outcome {
  threadCreated: boolean;
  rpcError: Record<string, unknown> | null;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function startupArguments(): string[] {
  const options = fixtureClientOptions();
  const args = [RESTRICTED_BINARY, 'app-server', '--stdio', '--strict-config'];
  function flatten(value: Record<string, unknown>, prefix = ''): void {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? prefix + '.' + key : key;
      if (object(item)) flatten(item, path);
      else args.push('-c', path + '=' + JSON.stringify(item));
    }
  }
  flatten(options.config ?? {});
  for (const value of options.configOverrides ?? []) args.push('-c', value);
  // The SDK emits these values for the previous fixture's query. No server is
  // listening at this synthetic endpoint; this diagnostic never sends a turn.
  args.push('-c', 'web_search="disabled"', '-c', 'openai_base_url="http://127.0.0.1:9/v1"');
  return args;
}

export class StartupProtocol {
  private state: 'new' | 'initialize' | 'thread' | 'complete' | 'failed' = 'new';
  private result?: Outcome;
  private notified = false;

  begin(): Message {
    if (this.state !== 'new') throw new Error('startup protocol already started');
    this.state = 'initialize';
    return {
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
    };
  }

  accept(value: unknown): Message[] {
    try {
      return this.consume(value);
    } catch {
      this.state = 'failed';
      throw new Error('startup protocol response rejected');
    }
  }

  private consume(value: unknown): Message[] {
    if (!object(value) || !['initialize', 'thread'].includes(this.state)) throw new Error();
    if (value.jsonrpc !== undefined && value.jsonrpc !== '2.0') throw new Error();
    if (value.id === undefined) {
      if (
        this.state !== 'thread' ||
        this.notified ||
        value.method !== 'thread/started' ||
        Object.keys(value).some(key => !['method', 'params', 'jsonrpc'].includes(key)) ||
        !object(value.params) ||
        !object(value.params.thread) ||
        typeof value.params.thread.id !== 'string' ||
        !value.params.thread.id
      )
        throw new Error();
      this.notified = true;
      return [];
    }
    if (
      value.id !== (this.state === 'initialize' ? 1 : 2) ||
      Object.keys(value).some(key => !['id', 'result', 'error', 'jsonrpc'].includes(key)) ||
      Object.hasOwn(value, 'error') === Object.hasOwn(value, 'result')
    )
      throw new Error();
    if (this.state === 'initialize') {
      const result = value.result;
      if (
        !object(result) ||
        Object.keys(result).length !== 4 ||
        result.codexHome !== '/home/appuser/.codex' ||
        result.platformFamily !== 'unix' ||
        result.platformOs !== 'linux' ||
        typeof result.userAgent !== 'string' ||
        !/^[\x20-\x7e]{1,1024}$/.test(result.userAgent) ||
        !result.userAgent.startsWith('codex_exec/0.153.3 (') ||
        !result.userAgent.endsWith(' (codex_exec; 0.153.3)')
      )
        throw new Error();
      this.state = 'thread';
      return [
        { method: 'initialized' },
        {
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
        },
      ];
    }
    if (Object.hasOwn(value, 'error')) {
      const error = value.error;
      if (
        !object(error) ||
        Object.keys(error).some(key => !['code', 'message', 'data'].includes(key)) ||
        !Number.isInteger(error.code) ||
        (error.code as number) < -2147483648 ||
        (error.code as number) > 2147483647 ||
        typeof error.message !== 'string' ||
        Buffer.byteLength(error.message) < 1 ||
        Buffer.byteLength(error.message) > 32768
      )
        throw new Error();
      this.result = { threadCreated: false, rpcError: structuredClone(error) };
    } else {
      if (
        !object(value.result) ||
        !object(value.result.thread) ||
        typeof value.result.thread.id !== 'string' ||
        !value.result.thread.id
      )
        throw new Error();
      this.result = { threadCreated: true, rpcError: null };
    }
    this.state = 'complete';
    return [];
  }

  outcome(): Outcome {
    if (this.state !== 'complete' || !this.result) throw new Error('startup protocol incomplete');
    return structuredClone(this.result);
  }
}

interface StartupChild {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  write: (value: string) => void;
  kill: () => void;
}

/** Bounded child exchange. Raw stderr is counted and discarded, never interpolated. */
export async function exchangeStartup(child: StartupChild, timeout = 12000): Promise<Outcome> {
  const protocol = new StartupProtocol();
  let bytes = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('startup deadline'));
    }, timeout);
  });
  function count(chunk: Uint8Array): void {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('startup output bound');
  }
  const errors = (async (): Promise<void> => {
    for await (const chunk of child.stderr) count(chunk);
  })();
  const output = (async (): Promise<Outcome> => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    child.write(JSON.stringify(protocol.begin()) + '\n');
    for await (const chunk of child.stdout) {
      count(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) throw new Error('startup empty line');
        const response = parseUniqueFixtureJson(Buffer.from(line));
        for (const request of protocol.accept(response))
          child.write(JSON.stringify(request) + '\n');
        if ((response as { id?: unknown }).id === 2) {
          const result = protocol.outcome();
          done = true;
          child.kill();
          return result;
        }
      }
    }
    decoder.decode();
    throw new Error('startup incomplete response');
  })();
  try {
    const [result] = await Promise.race([Promise.all([output, errors]), deadline]);
    if (!done) throw new Error('startup incomplete');
    return result;
  } catch {
    throw new Error('startup exchange rejected');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    child.kill();
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<never>((_resolve, reject) => {
          reapTimer = setTimeout(() => {
            reject(new Error('startup child reap rejected'));
          }, 5000);
        }),
      ]);
    } finally {
      if (reapTimer !== undefined) clearTimeout(reapTimer);
    }
  }
}
