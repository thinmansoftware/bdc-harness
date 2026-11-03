/**
 * openrouter-fence-dispatch.test.ts -- WO-HARNESS-OPENROUTER-REVIEW-DIFF-SCAN-01
 *
 * Exercises the REAL dispatch paths (executeDagWorkflow -> executeNodeInternal
 * for a prompt node, executeLoopNode for a loop node) on a real git checkout
 * whose origin is a customer repository. Proves the review fence scans the
 * COMPLETE serialized OpenRouter request -- system/persona prompt, user prompt
 * and the appended outputFormat.schema -- before anything is sent
 * (Overseer major on PRs 1426/1428):
 *   - a secret in the system prompt routes the node away from OpenRouter
 *   - a customer email in the output_format schema routes it away
 *   - a clean request still goes to OpenRouter, pinned, and the text the fence
 *     scanned is byte-identical to the content the OpenRouter seat transmits.
 *
 * The OpenRouter seat here builds its messages with the same shared
 * buildOpenRouterChatMessages GlmProvider uses (GlmProvider's own test proves
 * its transmitted body equals that builder's output). Only gitleaks is stubbed
 * (the binary is not installed in CI); the customer-data patterns are real.
 *
 * Runs in its own `bun test` invocation (process-global mock.module()).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

// --- Mock logger (MUST come before imports of modules under test) ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));
mock.module('@archon/persona-context-loader', () => ({
  loadContext: mock(() => Promise.resolve('')),
}));

// --- Real providers module, with ONLY the gitleaks runner stubbed ---
import * as realProviders from '@archon/providers';
import type { ScanOptions, SendQueryOptions } from '@archon/providers';
const realScan = realProviders.scanDiffForOpenRouter;
const realBuildMessages = realProviders.buildOpenRouterChatMessages;
const realSerialize = realProviders.serializeOpenRouterRequestContent;
/** Every text the fence scanned in prompt mode, in order. */
const promptScans: string[] = [];
mock.module('@archon/providers', () => ({
  ...realProviders,
  scanDiffForOpenRouter: (text: string, opts: ScanOptions) => {
    if (opts.mode === 'prompt') promptScans.push(text);
    return realScan(text, {
      ...opts,
      gitleaksRunner: () => Promise.resolve({ available: true, findings: [] }),
    });
  },
}));
realProviders.clearRegistry();
realProviders.registerBuiltinProviders();
realProviders.registerCommunityProviders();

// --- Imports (after mocks) ---
import { executeDagWorkflow, clearOpenRouterDiffScanCache } from './dag-executor';
import type { DagNode, WorkflowRun } from './schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';

type Chunk = Record<string, unknown>;
interface CapturedEvent {
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
}
interface Sent {
  provider: string;
  prompt: string;
  options: SendQueryOptions | undefined;
  /** For the OpenRouter seat: the content it transmits. */
  transmitted?: string;
}

const CAPS = () => ({
  execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
  structuredOutput: true,
  envInjection: true,
  effortControl: true,
  thinkingControl: true,
  costControl: true,
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  toolRestrictions: true,
  fallbackModel: true,
  sandbox: true,
});

function makeProviders(sent: Sent[]) {
  return (provider: string) => ({
    sendQuery: (prompt: string, _cwd: string, _resume?: string, options?: SendQueryOptions) => {
      const entry: Sent = { provider, prompt, options };
      if (provider === 'opr') {
        // What an OpenRouter text seat sends: GlmProvider's message builder.
        entry.transmitted = realBuildMessages(prompt, options)
          .map(m => m.content)
          .join('\n\n');
      }
      sent.push(entry);
      return (function* (): Generator<Chunk, void, unknown> {
        yield { type: 'assistant', content: 'COMPLETE {"ok":true}' };
        yield { type: 'result', sessionId: 'sess', structuredOutput: { ok: true } };
      })();
    },
    getType: () => provider,
    getCapabilities: CAPS,
  });
}

interface RegisteredCodebase {
  name: string;
  repository_url: string | null;
}

function createMockStore(
  events: CapturedEvent[],
  codebase: RegisteredCodebase | null = null
): IWorkflowStore {
  const run: WorkflowRun = {
    id: `run-${Math.random().toString(36).slice(2)}`,
    workflow_name: 'mock',
    conversation_id: 'conv-mock',
    parent_conversation_id: null,
    codebase_id: codebase ? 'cb-1' : null,
    status: 'running',
    user_message: 'msg',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
  return {
    createWorkflowRun: mock(() => Promise.resolve(run)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() => Promise.resolve(run)),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    createRunAuthority: mock(() => Promise.resolve('created' as const)),
    getRunAuthority: mock(() => Promise.resolve(null)),
    claimRunLease: mock(() => Promise.resolve(null)),
    heartbeatRunLease: mock(() => Promise.resolve(false)),
    releaseRunLease: mock(() => Promise.resolve(false)),
    listExpiredRunLeases: mock(() => Promise.resolve([])),
    interruptExpiredRunLease: mock(() => Promise.resolve(false)),
    createProviderAttempt: mock(() => Promise.resolve(true)),
    completeProviderAttempt: mock(() => Promise.resolve(true)),
    listProviderAttempts: mock(() => Promise.resolve([])),
    upsertRunOutcome: mock(() => Promise.resolve(true)),
    getRunOutcome: mock(() => Promise.resolve(null)),
    scheduleProviderWait: mock(() => Promise.resolve(true)),
    listDueProviderWaits: mock(() => Promise.resolve([])),
    claimProviderWait: mock(() => Promise.resolve(false)),
    cancelProviderWaits: mock(() => Promise.resolve(0)),
    completeProviderWait: mock(() => Promise.resolve(false)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(
      (e: { event_type: string; step_name?: string | null; data?: Record<string, unknown> }) => {
        events.push({
          event_type: e.event_type,
          step_name: e.step_name ?? null,
          data: e.data ?? {},
        });
        return Promise.resolve();
      }
    ),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() =>
      Promise.resolve(codebase ? { id: 'cb-1', default_cwd: repoDir, ...codebase } : null)
    ),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  } as unknown as IWorkflowStore;
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

// A real customer-repo checkout: origin = thinmansoftware/lspro-react, a clean
// feature commit on top of main.
let repoDir: string;
const savedSlugs = process.env.OPENROUTER_FENCE_TENANT_SLUGS;
function git(...args: string[]): void {
  execFileSync('git', ['-C', repoDir, ...args], { stdio: 'ignore' });
}
beforeAll(async () => {
  process.env.OPENROUTER_FENCE_TENANT_SLUGS = 'mutant-market';
  repoDir = join(tmpdir(), `orfence-dispatch-${Math.random().toString(36).slice(2)}`);
  await mkdir(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'https://github.com/thinmansoftware/lspro-react.git');
  await writeFile(join(repoDir, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  await writeFile(join(repoDir, 'src.ts'), 'export const answer = 42;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'clean change');

  // Same shape, but NO origin remote: identity must come from run metadata.
  noOriginDir = join(tmpdir(), `orfence-noorigin-${Math.random().toString(36).slice(2)}`);
  await mkdir(noOriginDir, { recursive: true });
  const g = (...args: string[]): void => {
    execFileSync('git', ['-C', noOriginDir, ...args], { stdio: 'ignore' });
  };
  execFileSync('git', ['init', '-q', '-b', 'main', noOriginDir], { stdio: 'ignore' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false');
  await writeFile(join(noOriginDir, 'README.md'), 'base\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'feature');
  await writeFile(join(noOriginDir, 'src.ts'), 'export const answer = 42;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'clean change');
});
let noOriginDir: string;
afterAll(async () => {
  if (savedSlugs === undefined) delete process.env.OPENROUTER_FENCE_TENANT_SLUGS;
  else process.env.OPENROUTER_FENCE_TENANT_SLUGS = savedSlugs;
  await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  await rm(noOriginDir, { recursive: true, force: true }).catch(() => {});
});
beforeEach(() => {
  clearOpenRouterDiffScanCache();
  promptScans.length = 0;
});

async function runNode(
  node: DagNode,
  opts: { cwd?: string; codebase?: RegisteredCodebase } = {}
): Promise<{ sent: Sent[]; events: CapturedEvent[] }> {
  const events: CapturedEvent[] = [];
  const sent: Sent[] = [];
  const store = createMockStore(events, opts.codebase ?? null);
  const deps: WorkflowDeps = {
    store,
    getAgentProvider: makeProviders(sent) as unknown as WorkflowDeps['getAgentProvider'],
    loadConfig: mock(() => Promise.resolve(config)) as unknown as WorkflowDeps['loadConfig'],
  };
  const run = await store.createWorkflowRun({
    workflow_name: 'f',
    conversation_id: 'c',
    user_message: 'm',
  });
  const scratch = join(tmpdir(), `orfence-out-${Math.random().toString(36).slice(2)}`);
  await executeDagWorkflow(
    deps,
    createMockPlatform(),
    'conv',
    opts.cwd ?? repoDir,
    { name: 'fence-dispatch', nodes: [node] },
    run,
    'opr',
    undefined,
    join(scratch, 'artifacts'),
    join(scratch, 'logs'),
    'main',
    'docs/',
    config
  );
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  return { sent, events };
}

const SECRET = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const scanEvents = (events: CapturedEvent[]): CapturedEvent[] =>
  events.filter(e => e.event_type === 'openrouter_diff_scan');

describe('OpenRouter fence on the prompt-node dispatch path', () => {
  it('a secret in the system prompt routes the node away from OpenRouter', async () => {
    const { sent, events } = await runNode({
      id: 'diff-review',
      prompt: 'Review the change.',
      provider: 'opr',
      model: 'deepseek/deepseek-v4-pro',
      systemPrompt: `You are a reviewer. Billing key: ${SECRET}`,
      allowed_tools: [],
      failover_provider: 'codex',
    } as DagNode);

    expect(sent.some(s => s.provider === 'opr')).toBe(false);
    expect(sent.map(s => s.provider)).toEqual(['codex']);
    // The rerouted seat does not inherit the OpenRouter persona.
    expect(sent[0]?.options?.systemPrompt).toBeUndefined();
    expect(promptScans[0]).toContain(SECRET);
    const ev = scanEvents(events);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.data.verdict).toBe('hit');
    expect(ev[0]?.data.routed_provider).toBe('codex');
    expect(ev[0]?.data.hit_kinds).toContain('stripe_id');
    expect(JSON.stringify(ev[0]?.data)).not.toContain(SECRET);
  });

  it('a customer email in the output_format schema routes the node away from OpenRouter', async () => {
    const { sent, events } = await runNode({
      id: 'diff-review',
      prompt: 'Review the change.',
      provider: 'opr',
      model: 'deepseek/deepseek-v4-pro',
      output_format: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: 'Escalate to jane.customer@gmail.com' },
        },
      },
      allowed_tools: [],
      failover_provider: 'codex',
    } as DagNode);

    expect(sent.some(s => s.provider === 'opr')).toBe(false);
    expect(sent.map(s => s.provider)).toEqual(['codex']);
    // The schema reached the scanner as part of the serialized request.
    expect(promptScans[0]).toContain('jane.customer@gmail.com');
    expect(promptScans[0]).toContain('Respond with valid JSON only.');
    const ev = scanEvents(events);
    expect(ev[0]?.data.verdict).toBe('hit');
    expect(ev[0]?.data.hit_kinds).toContain('email');
  });

  it('a clean request still goes to OpenRouter, pinned, and the scan covers exactly what is sent', async () => {
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string', description: 'APPROVE or REJECT' } },
    };
    const { sent, events } = await runNode({
      id: 'diff-review',
      prompt: 'Review the change.',
      provider: 'opr',
      model: 'deepseek/deepseek-v4-pro',
      systemPrompt: 'You are a careful code reviewer.',
      output_format: schema,
      allowed_tools: [],
      failover_provider: 'codex',
    } as DagNode);

    expect(sent.map(s => s.provider)).toEqual(['opr']);
    const opr = sent[0];
    expect(opr?.options?.openrouterPrivacyPin).toBe(true);
    expect(opr?.options?.systemPrompt).toBe('You are a careful code reviewer.');
    expect(opr?.options?.outputFormat).toEqual({ type: 'json_schema', schema });
    // Fence scanned the complete serialized request BEFORE send, and it is the
    // very content the OpenRouter seat transmits.
    expect(promptScans).toHaveLength(1);
    expect(promptScans[0]).toBe(opr?.transmitted ?? '<missing>');
    expect(promptScans[0]).toBe(realSerialize(opr?.prompt ?? '', opr?.options));
    expect(promptScans[0]).toContain('You are a careful code reviewer.');
    expect(promptScans[0]).toContain('APPROVE or REJECT');
    expect(scanEvents(events)[0]?.data.verdict).toBe('clean');
  });
});

describe('OpenRouter fence on the loop-node dispatch path', () => {
  it('a secret in the loop system prompt routes the iteration away from OpenRouter', async () => {
    const { sent, events } = await runNode({
      id: 'review-loop',
      loop: { prompt: 'Review.', until: 'COMPLETE', max_iterations: 1 },
      provider: 'opr',
      model: 'deepseek/deepseek-v4-pro',
      systemPrompt: `Reviewer persona. Key: ${SECRET}`,
      allowed_tools: [],
      failover_provider: 'codex',
    } as DagNode);

    expect(sent.some(s => s.provider === 'opr')).toBe(false);
    expect(sent.map(s => s.provider)).toEqual(['codex']);
    expect(promptScans[0]).toContain(SECRET);
    expect(scanEvents(events)[0]?.data.verdict).toBe('hit');
  });

  it('a clean loop iteration still goes to OpenRouter, pinned, scanned as sent', async () => {
    const { sent, events } = await runNode({
      id: 'review-loop',
      loop: { prompt: 'Review.', until: 'COMPLETE', max_iterations: 1 },
      provider: 'opr',
      model: 'deepseek/deepseek-v4-pro',
      systemPrompt: 'Reviewer persona.',
      allowed_tools: [],
      failover_provider: 'codex',
    } as DagNode);

    expect(sent.map(s => s.provider)).toEqual(['opr']);
    expect(sent[0]?.options?.openrouterPrivacyPin).toBe(true);
    expect(promptScans[0]).toBe(sent[0]?.transmitted ?? '<missing>');
    expect(promptScans[0]).toContain('Reviewer persona.');
    expect(scanEvents(events)[0]?.data.verdict).toBe('clean');
  });
});

describe('OpenRouter fence repository identity (fail closed)', () => {
  const reviewNode = {
    id: 'diff-review',
    prompt: 'Review the change.',
    provider: 'opr',
    model: 'deepseek/deepseek-v4-pro',
    systemPrompt: 'You are a careful code reviewer.',
    allowed_tools: [],
    failover_provider: 'codex',
  } as DagNode;

  it('unknown origin + no run metadata -> rerouted off OpenRouter with the decision event', async () => {
    const { sent, events } = await runNode(reviewNode, { cwd: noOriginDir });

    expect(sent.some(s => s.provider === 'opr')).toBe(false);
    expect(sent.map(s => s.provider)).toEqual(['codex']);
    const ev = scanEvents(events);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.data.verdict).toBe('scan_unavailable');
    expect(ev[0]?.data.reason).toBe('repo_identity_unresolved');
    expect(ev[0]?.data.routed_provider).toBe('codex');
  });

  it('run metadata says a customer repo while origin is missing -> scanned and pinned', async () => {
    const { sent, events } = await runNode(reviewNode, {
      cwd: noOriginDir,
      codebase: {
        name: 'lspro-react',
        repository_url: 'https://github.com/thinmansoftware/lspro-react',
      },
    });

    expect(sent.map(s => s.provider)).toEqual(['opr']);
    expect(sent[0]?.options?.openrouterPrivacyPin).toBe(true);
    expect(promptScans).toHaveLength(1);
    expect(promptScans[0]).toBe(sent[0]?.transmitted ?? '<missing>');
    const ev = scanEvents(events);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.data.verdict).toBe('clean');
    expect(ev[0]?.data.repo).toBe('thinmansoftware/lspro-react');
  });

  it('run metadata wins over the checkout origin: internal codebase on a customer-origin checkout is not fenced', async () => {
    const { sent, events } = await runNode(reviewNode, {
      cwd: repoDir,
      codebase: {
        name: 'bdc-harness',
        repository_url: 'https://github.com/thinmansoftware/bdc-harness',
      },
    });
    expect(sent.map(s => s.provider)).toEqual(['opr']);
    expect(scanEvents(events)).toHaveLength(0);
  });

  it('a known internal repo still goes to OpenRouter, unscanned and unpinned', async () => {
    const { sent, events } = await runNode(reviewNode, {
      cwd: noOriginDir,
      codebase: {
        name: 'bdc-harness',
        repository_url: 'https://github.com/thinmansoftware/bdc-harness',
      },
    });

    expect(sent.map(s => s.provider)).toEqual(['opr']);
    expect(sent[0]?.options?.openrouterPrivacyPin).toBeFalsy();
    expect(promptScans).toHaveLength(0);
    expect(scanEvents(events)).toHaveLength(0);
  });
});
