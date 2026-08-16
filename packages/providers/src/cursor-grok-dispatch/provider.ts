import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  ProviderExecutionContext,
  SendQueryOptions,
} from '../types';
import { CURSOR_GROK_DISPATCH_CAPABILITIES } from './capabilities';

const execFileAsync = promisify(execFile);
const EXACT_MODEL = 'cursor-grok-4.5-high';
const PROTECTED_BRANCH = /^(main|master|dev|staging|production|release(?:\/.*)?)$/i;

type GitRunner = (args: string[], cwd: string) => Promise<string>;

interface DispatchMessageResponse {
  id: string;
  task_type?: string;
  status: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
  result_body?: string | null;
}

interface TransferredArtifact {
  path: string;
  sha256: string;
  content_base64: string;
  size_bytes: number;
}

interface RunWorkResult {
  version: 'v1';
  worker_id: string;
  fencing_token: number;
  outcome: 'succeeded' | 'failed' | 'timed_out' | 'blocked';
  requested_sha: string;
  resulting_sha: string | null;
  output: string;
  model: typeof EXACT_MODEL;
  artifacts: { outputs: TransferredArtifact[] };
}

export interface CursorGrokDispatchProviderOptions {
  serverUrl?: string;
  operatorToken?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  runGit?: GitRunner;
}

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

function assertSafeArtifactPath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe artifact path: ${path}`);
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('cursor_grok_dispatch_aborted'));
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('cursor_grok_dispatch_aborted'));
      },
      { once: true }
    );
  });
}

export class CursorGrokDispatchProvider implements IAgentProvider {
  private readonly serverUrl: string;
  private readonly operatorToken: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly runGit: GitRunner;

  constructor(options: CursorGrokDispatchProviderOptions = {}) {
    this.serverUrl = (
      options.serverUrl ??
      process.env.ARCHON_INTERNAL_URL ??
      process.env.ARCHON_API_BASE_URL ??
      'http://127.0.0.1:3090'
    ).replace(/\/+$/, '');
    this.operatorToken = options.operatorToken ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 7_200_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  getType(): string {
    return 'cursor-grok-dispatch';
  }

  getCapabilities(): ProviderCapabilities {
    return CURSOR_GROK_DISPATCH_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const context = options?.executionContext;
    if (!context) throw new Error('cursor-grok-dispatch requires executionContext');
    if (!this.operatorToken)
      throw new Error('ARCHON_OPERATOR_TOKEN is required for cursor-grok-dispatch');
    if (options?.model && options.model !== EXACT_MODEL) {
      throw new Error(`cursor-grok-dispatch requires model ${EXACT_MODEL}`);
    }

    const [remoteUrl, requestedSha, branch, status] = await Promise.all([
      this.runGit(['remote', 'get-url', 'origin'], cwd),
      this.runGit(['rev-parse', 'HEAD'], cwd),
      this.runGit(['branch', '--show-current'], cwd),
      this.runGit(['status', '--porcelain'], cwd),
    ]);
    if (!/^[0-9a-f]{40}$/i.test(requestedSha)) throw new Error('invalid requested git SHA');
    if (!branch || PROTECTED_BRANCH.test(branch))
      throw new Error('run_work protected branch rejected');
    if (status.trim()) throw new Error('run_work requires a clean assigned worktree');

    const inputs = await this.readInputs(context);
    const request = {
      version: 'v1' as const,
      correlation_id: `${context.workflowRunId}:${context.nodeId}`,
      idempotency_key: `${context.workflowRunId}:${context.nodeId}:${context.providerAttemptId}`,
      workflow_run_id: context.workflowRunId,
      node_id: context.nodeId,
      provider_attempt_id: context.providerAttemptId,
      provider_attempt_number: context.providerAttemptNumber,
      execution_mode: context.executionMode,
      repository: {
        remote_url: remoteUrl,
        branch,
        requested_sha: requestedSha,
      },
      model: EXACT_MODEL,
      prompt,
      artifacts: {
        source_root: context.artifactsDir,
        inputs,
        outputs: context.artifactContract.outputs,
        max_file_bytes: context.artifactContract.maxFileBytes,
        max_total_bytes: context.artifactContract.maxTotalBytes,
      },
    };

    const created = await this.request<DispatchMessageResponse>('/api/dispatch/work-requests', {
      method: 'POST',
      body: JSON.stringify(request),
      signal: options?.abortSignal,
    });
    yield { type: 'system', content: `Cursor Desktop work queued: ${created.id}` };

    const deadline = Date.now() + this.timeoutMs;
    let message = created;
    while (message.status === 'queued' || message.status === 'claimed') {
      if (Date.now() >= deadline) throw new Error('cursor_grok_dispatch_timed_out');
      await sleep(this.pollIntervalMs, options?.abortSignal);
      message = await this.request<DispatchMessageResponse>(
        `/api/dispatch/work-requests/${encodeURIComponent(created.id)}`,
        { signal: options?.abortSignal }
      );
    }
    if (!message.result_body) {
      throw new Error(`cursor_grok_dispatch_${message.status}_without_result`);
    }
    const result = this.parseResult(message.result_body, request, context);
    if (result.outcome !== 'succeeded' || message.status !== 'done') {
      throw new Error(`cursor_grok_dispatch_${result.outcome}: ${result.output}`);
    }

    await this.restoreOutputs(result.artifacts.outputs, context);
    if (context.executionMode === 'repository_write') {
      await this.fastForwardAssignedWorktree(cwd, branch, requestedSha, result.resulting_sha);
    } else if (result.resulting_sha !== requestedSha) {
      throw new Error('read_only run_work changed repository SHA');
    }
    if (result.output) yield { type: 'assistant', content: result.output };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('x-archon-operator-token', this.operatorToken);
    const response = await this.fetchFn(`${this.serverUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok)
      throw new Error(`cursor_grok_dispatch_http_${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  private async readInputs(context: ProviderExecutionContext): Promise<TransferredArtifact[]> {
    if (context.artifactContract.inputs.length === 0) return [];
    const root = resolve(context.artifactsDir);
    const rootReal = await realpath(root);
    const outputs: TransferredArtifact[] = [];
    let total = 0;
    for (const path of context.artifactContract.inputs) {
      assertSafeArtifactPath(path);
      const fullPath = resolve(root, path);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error(`artifact input must be a regular file: ${path}`);
      const fileReal = await realpath(fullPath);
      const rel = relative(rootReal, fileReal);
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
        throw new Error(`artifact input escapes root: ${path}`);
      }
      const content = await readFile(fileReal);
      total += content.length;
      if (
        content.length > context.artifactContract.maxFileBytes ||
        total > context.artifactContract.maxTotalBytes
      ) {
        throw new Error('artifact input exceeds transfer limit');
      }
      outputs.push({
        path,
        sha256: sha256(content),
        content_base64: content.toString('base64'),
        size_bytes: content.length,
      });
    }
    return outputs;
  }

  private parseResult(
    text: string,
    request: {
      repository: { requested_sha: string };
      model: string;
      artifacts: { outputs: string[] };
    },
    context: ProviderExecutionContext
  ): RunWorkResult {
    const result = JSON.parse(text) as RunWorkResult;
    if (
      result.version !== 'v1' ||
      result.model !== EXACT_MODEL ||
      result.requested_sha !== request.repository.requested_sha ||
      !result.artifacts ||
      !Array.isArray(result.artifacts.outputs)
    ) {
      throw new Error('invalid cursor_grok_dispatch result contract');
    }
    const allowed = new Set(request.artifacts.outputs);
    let total = 0;
    for (const artifact of result.artifacts.outputs) {
      assertSafeArtifactPath(artifact.path);
      const content = Buffer.from(artifact.content_base64, 'base64');
      total += content.length;
      if (
        !allowed.has(artifact.path) ||
        content.length !== artifact.size_bytes ||
        sha256(content) !== artifact.sha256 ||
        content.length > context.artifactContract.maxFileBytes ||
        total > context.artifactContract.maxTotalBytes
      ) {
        throw new Error('invalid cursor_grok_dispatch output artifact');
      }
    }
    return result;
  }

  private async restoreOutputs(
    artifacts: TransferredArtifact[],
    context: ProviderExecutionContext
  ): Promise<void> {
    const root = resolve(context.artifactsDir);
    await mkdir(root, { recursive: true });
    for (const artifact of artifacts) {
      const destination = resolve(root, artifact.path);
      const rel = relative(root, destination);
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
        throw new Error(`artifact output escapes root: ${artifact.path}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp-${context.providerAttemptId}`;
      await writeFile(temporary, Buffer.from(artifact.content_base64, 'base64'), { flag: 'wx' });
      try {
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
  }

  private async fastForwardAssignedWorktree(
    cwd: string,
    branch: string,
    requestedSha: string,
    resultingSha: string | null
  ): Promise<void> {
    if (!resultingSha || !/^[0-9a-f]{40}$/i.test(resultingSha) || resultingSha === requestedSha) {
      throw new Error('repository_write result requires a new commit SHA');
    }
    const current = await this.runGit(['rev-parse', 'HEAD'], cwd);
    if (current !== requestedSha) throw new Error('assigned worktree moved while desktop work ran');
    await this.runGit(['fetch', 'origin', branch], cwd);
    const fetched = await this.runGit(['rev-parse', 'FETCH_HEAD'], cwd);
    if (fetched !== resultingSha)
      throw new Error('desktop result SHA does not match fetched branch');
    await this.runGit(['merge-base', '--is-ancestor', requestedSha, resultingSha], cwd);
    await this.runGit(['merge', '--ff-only', resultingSha], cwd);
  }
}
