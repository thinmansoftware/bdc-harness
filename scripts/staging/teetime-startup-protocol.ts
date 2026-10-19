// Pure non-query diagnostic protocol. No SDK, native process, network or registration.
import { fixtureClientOptions, parseUniqueFixtureJson } from './teetime-reviewer-fixture';
import { RESTRICTED_BINARY } from '../../packages/providers/src/codex/restricted-policy';

export function startupCommandOutput(result: {
  success: boolean; exitCode: number; signalCode?: string | null;
  stdout: Uint8Array; stderr: Uint8Array;
  exitedDueToTimeout?: boolean; exitedDueToMaxBuffer?: boolean;
}, maxBuffer: number): Uint8Array {
  if (result.success !== true || result.exitCode !== 0
      || (result.signalCode !== null && result.signalCode !== undefined)
      || result.exitedDueToTimeout === true || result.exitedDueToMaxBuffer === true
      || result.stdout.length + result.stderr.length > maxBuffer)
    throw new Error('startup command rejected');
  return result.stdout;
}

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

export type StartupRejectionCategory = 'write' | 'utf8-json' | 'notification-shape'
  | 'response-envelope' | 'response-payload' | 'output-bound' | 'eof-incomplete'
  | 'deadline' | 'stream' | 'unknown';
export interface StartupExchangeObservation {
  category: StartupRejectionCategory;
  response2Observed: boolean;
  acceptedNotifications: number;
  observedBytes: number; // Saturates at 65537, meaning at least 65537 bytes.
  reapUncertain: boolean;
}
// Only this module can brand a fault. Never inspect caller-controlled error data.
class StartupFault extends Error {
  constructor(readonly category: StartupRejectionCategory) { super('startup rejected'); }
}
function reject(category: StartupRejectionCategory): never { throw new StartupFault(category); }
function categoryOf(error: unknown): StartupRejectionCategory {
  return error instanceof StartupFault ? error.category : 'unknown';
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
    } catch (error) {
      this.state = 'failed';
      throw new StartupFault(categoryOf(error));
    }
  }

  private consume(value: unknown): Message[] {
    if (!object(value) || !['initialize', 'thread'].includes(this.state)) reject('response-envelope');
    if (value.jsonrpc !== undefined && value.jsonrpc !== '2.0') reject('response-envelope');
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
        reject('notification-shape');
      this.notified = true;
      return [];
    }
    if (
      value.id !== (this.state === 'initialize' ? 1 : 2) ||
      Object.keys(value).some(key => !['id', 'result', 'error', 'jsonrpc'].includes(key)) ||
      Object.hasOwn(value, 'error') === Object.hasOwn(value, 'result')
    )
      reject('response-envelope');
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
        reject('response-payload');
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
        reject('response-payload');
      this.result = { threadCreated: false, rpcError: structuredClone(error) };
    } else {
      if (
        !object(value.result) ||
        !object(value.result.thread) ||
        typeof value.result.thread.id !== 'string' ||
        !value.result.thread.id
      )
        reject('response-payload');
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
export async function exchangeStartup(child: StartupChild, timeout = 12000,
  observePhase?: (phase: 'initialize-exchange' | 'thread-start-exchange') => void,
  observeFailure?: (value: StartupExchangeObservation) => void
): Promise<Outcome> {
  const protocol = new StartupProtocol();
  let bytes = 0, acceptedNotifications = 0;
  let response2Observed = false, done = false, reapUncertain = false;
  let primary: StartupRejectionCategory | undefined;
  let outcome: Outcome | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, rejectDeadline) => {
    timer = setTimeout(() => {
      const error = new StartupFault('deadline');
      primary ??= error.category;
      rejectDeadline(error);
    }, timeout);
  });
  function count(chunk: Uint8Array): void {
    bytes = Math.min(65537, bytes + chunk.length);
    if (bytes > 65536) reject('output-bound');
  }
  function stop(): void {
    try { child.kill(); } catch { reapUncertain = true; }
  }
  function write(value: string): void {
    try { child.write(value); } catch { primary ??= 'write'; reject('write'); }
  }
  function phase(value: 'initialize-exchange' | 'thread-start-exchange'): void {
    try { observePhase?.(value); } catch { primary ??= 'unknown'; reject('unknown'); }
  }
  const errors = (async (): Promise<void> => {
    try { for await (const chunk of child.stderr) count(chunk); }
    catch (error) {
      const category = error instanceof StartupFault ? error.category : 'stream';
      primary ??= category;
      throw new StartupFault(category);
    }
  })();
  const output = (async (): Promise<Outcome> => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    try {
      phase('initialize-exchange');
      let initial: Message;
      try { initial = protocol.begin(); } catch { primary ??= 'unknown'; reject('unknown'); }
      write(JSON.stringify(initial) + '\n');
      for await (const chunk of child.stdout) {
        count(chunk);
        try { buffer += decoder.decode(chunk, { stream: true }); }
        catch { reject('utf8-json'); }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let response: unknown;
          try {
            if (!line.trim()) reject('utf8-json');
            response = parseUniqueFixtureJson(Buffer.from(line));
          } catch { reject('utf8-json'); }
          if (object(response) && response.id === 2) response2Observed = true;
          const requests = protocol.accept(response);
          if (object(response) && response.id === undefined) acceptedNotifications++;
          for (const request of requests) {
            if (request.method === 'thread/start') phase('thread-start-exchange');
            write(JSON.stringify(request) + '\n');
          }
          if (object(response) && response.id === 2) {
            const result = protocol.outcome();
            done = true;
            stop();
            return result;
          }
        }
      }
      try { decoder.decode(); } catch { reject('utf8-json'); }
      reject('eof-incomplete');
    } catch (error) {
      const category = error instanceof StartupFault ? error.category : 'stream';
      primary ??= category;
      throw new StartupFault(category);
    }
  })();
  try {
    const [result] = await Promise.race([Promise.all([output, errors]), deadline]);
    if (!done) reject('eof-incomplete');
    outcome = result;
  } catch (error) {
    primary ??= categoryOf(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    stop();
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exited,
        new Promise<never>((_resolve, rejectReap) => {
          reapTimer = setTimeout(() => rejectReap(new Error('startup child reap rejected')), 5000);
        }),
      ]);
    } catch { reapUncertain = true; }
    finally { if (reapTimer !== undefined) clearTimeout(reapTimer); }
    if (primary !== undefined || reapUncertain) {
      const observation: StartupExchangeObservation = {
        category: primary ?? 'unknown', response2Observed, acceptedNotifications,
        observedBytes: bytes, reapUncertain,
      };
      // Final snapshot only; late stream settlement cannot change this evidence.
      try { observeFailure?.({ ...observation }); } catch { /* Fail closed, no raw observer errors. */ }
    }
  }
  if (primary !== undefined || reapUncertain || outcome === undefined)
    throw new Error('startup exchange rejected');
  return outcome;
}
