/**
 * CursorCloudAgentProvider -- one Cursor Cloud Agent per Cauldron workflow run.
 *
 * The implement loop dispatches here. The first sendQuery for a run creates the
 * agent (client-supplied id `bc-<uuid v5 of the run id>`). Later iterations of
 * the same provider instance send a follow-up run to that agent. The local
 * cursor-agent CLI stays available when CURSOR_LANE_IMPLEMENT_TRANSPORT=cli.
 *
 * The agent is never deleted. John opens the url the API returns.
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@archon/paths';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { CURSOR_AGENT_CAPABILITIES } from './capabilities';
import {
  CursorCloudAgentClient,
  CursorCloudHttpError,
  type CursorCloudAgentRecord,
  type CursorCloudRunRecord,
} from './cloud-agent-client';
import { CursorAgentProvider, DEFAULT_CURSOR_AGENT_MODEL } from './provider';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const POLL_INTERVAL_MS = 10_000;
const TERMINAL_FAILURE = new Set(['ERROR', 'EXPIRED', 'CANCELLED']);
const TERMINAL_ANY = new Set(['FINISHED', 'ERROR', 'EXPIRED', 'CANCELLED']);

export interface CursorCloudCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CursorCloudCommandRunner = (
  argv: string[],
  options: { cwd: string }
) => Promise<CursorCloudCommandResult>;

export interface CursorCloudAgentMetadata {
  cursor_cloud_agent: {
    agent_id: string;
    url: string;
    run_ids: string[];
    created_at: string;
  };
}

export type CursorCloudMetadataRecorder = (
  runId: string,
  metadata: CursorCloudAgentMetadata
) => Promise<void>;

export interface CursorCloudAgentProviderDeps {
  fetchImpl?: typeof fetch;
  git?: CursorCloudCommandRunner;
  gh?: CursorCloudCommandRunner;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  cli?: IAgentProvider;
  recorder?: CursorCloudMetadataRecorder | null;
  now?: () => Date;
}

interface CloudBinding {
  agentId: string;
  url: string;
  createdAt: string;
  runIds: string[];
  commentPosted: boolean;
}

let moduleRecorder: CursorCloudMetadataRecorder | null = null;
let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.cursor-cloud');
  return cachedLog;
}

export function setCursorCloudRunMetadataRecorder(
  recorder: CursorCloudMetadataRecorder | null
): void {
  moduleRecorder = recorder;
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** RFC 4122 UUID v5 (SHA-1, DNS namespace) of the raw workflow run id, prefixed `bc-`. */
export function cursorCloudAgentId(runId: string): string {
  const namespace = uuidBytes(DNS_NAMESPACE);
  const name = new TextEncoder().encode(runId);
  const data = new Uint8Array(namespace.length + name.length);
  data.set(namespace, 0);
  data.set(name, namespace.length);
  const hash = createHash('sha1').update(data).digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return `bc-${formatUuid(bytes)}`;
}

function normalizeRemoteToOwnerRepo(url: string): string | null {
  const trimmed = url.trim();
  const sshMatch = /[^:@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (sshMatch?.[1]) return sshMatch[1].toLowerCase();
  const httpsMatch = /https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/.exec(trimmed);
  if (httpsMatch?.[1]) return httpsMatch[1].toLowerCase();
  return null;
}

function cloudPrompt(prompt: string, branch: string): string {
  return `${prompt}\n\nCommit and push every change to branch ${branch}. Never open a pull request.\n`;
}

function agentName(woId: string, runId: string): string {
  return `Cauldron ${woId} run ${runId.slice(0, 8)}`.slice(0, 100);
}

function redact(message: string, key: string): string {
  if (!key) return message;
  const token = Buffer.from(`${key}:`, 'utf8').toString('base64');
  return message.split(key).join('[redacted]').split(token).join('[redacted]');
}

async function spawnCommand(
  argv: string[],
  options: { cwd: string }
): Promise<CursorCloudCommandResult> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class CursorCloudAgentProvider implements IAgentProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly git: CursorCloudCommandRunner;
  private readonly gh: CursorCloudCommandRunner;
  private readonly envBag: Record<string, string | undefined> | undefined;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly cli: IAgentProvider;
  private readonly recorderOverride: CursorCloudMetadataRecorder | null | undefined;
  private readonly now: () => Date;
  private readonly bindings = new Map<string, CloudBinding>();

  constructor(deps?: CursorCloudAgentProviderDeps) {
    this.fetchImpl = deps?.fetchImpl ?? fetch;
    this.git = deps?.git ?? spawnCommand;
    this.gh = deps?.gh ?? spawnCommand;
    this.envBag = deps?.env;
    this.sleepImpl = deps?.sleep ?? defaultSleep;
    this.cli = deps?.cli ?? new CursorAgentProvider();
    this.recorderOverride = deps?.recorder;
    this.now = deps?.now ?? ((): Date => new Date());
  }

  getType(): string {
    return 'cursor-cloud';
  }

  getCapabilities(): ProviderCapabilities {
    return CURSOR_AGENT_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const transport = (this.readEnv('CURSOR_LANE_IMPLEMENT_TRANSPORT') ?? '').trim();
    if (transport !== '' && transport !== 'cloud' && transport !== 'cli') {
      throw new Error('CURSOR_LANE_IMPLEMENT_TRANSPORT invalid');
    }
    if (transport === 'cli') {
      yield* this.cli.sendQuery(prompt, cwd, resumeSessionId, options);
      return;
    }

    const runId = options?.env?.ARCHON_WORKFLOW_RUN_ID ?? '';
    const woId = options?.env?.WO_ID ?? '';
    if (!runId || !woId) {
      throw new Error('CURSOR_CLOUD_CONTEXT_MISSING');
    }
    if (!cwd) {
      throw new Error('provider:cursor-cloud requires a non-empty cwd (worktree path)');
    }
    const key = (this.readEnv('CURSOR_API_KEY') ?? '').trim();
    if (!key) {
      throw new Error('CURSOR_API_KEY required for cursor-cloud transport');
    }

    const client = new CursorCloudAgentClient({ apiKey: key, fetchImpl: this.fetchImpl });
    const repoUrl = await this.resolveRepoUrl(cwd, key);
    const branch = await this.prepareBranch(cwd, woId, runId, key);
    const preDispatchSha = await this.gitStdout(cwd, ['rev-parse', 'HEAD'], key);
    await this.pushBranch(cwd, branch, key);

    const model = options?.model ?? DEFAULT_CURSOR_AGENT_MODEL;
    const text = cloudPrompt(prompt, branch);
    const deterministicId = cursorCloudAgentId(runId);
    const binding = await this.ensureBinding(client, {
      runId,
      woId,
      deterministicId,
      model,
      repoUrl,
      branch,
      text,
      key,
    });
    const cloudRunId = binding.runIds[binding.runIds.length - 1] ?? '';

    yield { type: 'assistant', content: `CURSOR_CLOUD_AGENT_URL=${binding.url}` };
    await this.announce(cwd, woId, runId, binding, key);
    yield* this.poll(
      client,
      binding,
      cloudRunId,
      cwd,
      branch,
      preDispatchSha,
      key,
      options?.abortSignal
    );
  }

  private readEnv(name: string): string | undefined {
    if (this.envBag) return this.envBag[name];
    return process.env[name];
  }

  private activeRecorder(): CursorCloudMetadataRecorder | null {
    if (this.recorderOverride !== undefined) return this.recorderOverride;
    return moduleRecorder;
  }

  private fail(message: string, key: string): Error {
    return new Error(redact(message, key));
  }

  private async gitResult(cwd: string, args: string[]): Promise<CursorCloudCommandResult> {
    return this.git(['git', ...args], { cwd });
  }

  private async gitStdout(cwd: string, args: string[], key: string): Promise<string> {
    const result = await this.gitResult(cwd, args);
    if (result.code !== 0 || !result.stdout) {
      throw this.fail(
        `cursor-cloud git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
        key
      );
    }
    return result.stdout;
  }

  private async resolveRepoUrl(cwd: string, key: string): Promise<string> {
    const result = await this.gitResult(cwd, ['remote', 'get-url', 'origin']);
    const ownerRepo = result.code === 0 ? normalizeRemoteToOwnerRepo(result.stdout) : null;
    if (!ownerRepo) {
      throw this.fail('CURSOR_CLOUD_REPO_UNRESOLVED', key);
    }
    return `https://github.com/${ownerRepo}`;
  }

  private async prepareBranch(
    cwd: string,
    woId: string,
    runId: string,
    key: string
  ): Promise<string> {
    const current = await this.gitStdout(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], key);
    if (current !== 'HEAD') return current;
    const branch = `cauldron/${woId}-${runId.slice(0, 8)}`;
    const created = await this.gitResult(cwd, ['checkout', '-b', branch]);
    if (created.code !== 0) {
      throw this.fail(`cursor-cloud could not create branch ${branch}: ${created.stderr}`, key);
    }
    return branch;
  }

  private async pushBranch(cwd: string, branch: string, key: string): Promise<void> {
    const pushed = await this.gitResult(cwd, ['push', '-u', 'origin', branch]);
    if (pushed.code !== 0) {
      throw this.fail(`cursor-cloud push failed: ${pushed.stderr}`, key);
    }
  }

  private async ensureBinding(
    client: CursorCloudAgentClient,
    input: {
      runId: string;
      woId: string;
      deterministicId: string;
      model: string;
      repoUrl: string;
      branch: string;
      text: string;
      key: string;
    }
  ): Promise<CloudBinding> {
    const existing = this.bindings.get(input.runId);
    if (existing) {
      const follow = await this.followUp(client, existing.agentId, input.text, input.key);
      existing.runIds.push(follow.id);
      await this.record(input.runId, existing, input.key);
      return existing;
    }

    try {
      const created = await client.createAgent({
        promptText: input.text,
        modelId: input.model,
        name: agentName(input.woId, input.runId),
        repoUrl: input.repoUrl,
        startingRef: input.branch,
        agentId: input.deterministicId,
      });
      const cloudRunId = created.runId;
      if (!cloudRunId) {
        throw this.fail(`cursor-cloud create returned no run id agent ${created.id}`, input.key);
      }
      const binding = this.bindingFrom(created, created.createdAt, cloudRunId);
      this.bindings.set(input.runId, binding);
      await this.record(input.runId, binding, input.key);
      return binding;
    } catch (err) {
      if (err instanceof CursorCloudHttpError && err.status === 409) {
        const agent = await client.getAgent(input.deterministicId);
        const follow = await this.followUp(client, agent.id, input.text, input.key);
        const binding = this.bindingFrom(agent, agent.createdAt, follow.id);
        this.bindings.set(input.runId, binding);
        await this.record(input.runId, binding, input.key);
        return binding;
      }
      if (
        err instanceof Error &&
        err.message.startsWith('cursor-cloud create returned no run id')
      ) {
        throw err;
      }
      throw this.fail(err instanceof Error ? err.message : 'cursor-cloud create failed', input.key);
    }
  }

  private bindingFrom(
    agent: CursorCloudAgentRecord,
    createdAt: string | undefined,
    cloudRunId: string
  ): CloudBinding {
    return {
      agentId: agent.id,
      url: agent.url,
      createdAt: createdAt ?? this.now().toISOString(),
      runIds: [cloudRunId],
      commentPosted: false,
    };
  }

  private async followUp(
    client: CursorCloudAgentClient,
    agentId: string,
    text: string,
    key: string
  ): Promise<CursorCloudRunRecord> {
    try {
      return await client.createRun(agentId, text);
    } catch (err) {
      throw this.fail(err instanceof Error ? err.message : 'cursor-cloud follow-up failed', key);
    }
  }

  private async record(runId: string, binding: CloudBinding, key: string): Promise<void> {
    const recorder = this.activeRecorder();
    if (!recorder) return;
    try {
      await recorder(runId, {
        cursor_cloud_agent: {
          agent_id: binding.agentId,
          url: binding.url,
          run_ids: [...binding.runIds],
          created_at: binding.createdAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'metadata recorder failed';
      getLog().warn({ runId, error: redact(message, key) }, 'cursor_cloud.metadata_record_failed');
    }
  }

  private async announce(
    cwd: string,
    woId: string,
    runId: string,
    binding: CloudBinding,
    key: string
  ): Promise<void> {
    if (binding.commentPosted) return;
    const marker = `<!-- cauldron-cursor-cloud-agent:${runId} -->`;
    try {
      const listed = await this.gh(
        [
          'gh',
          'issue',
          'list',
          '--repo',
          'thinmansoftware/bdc-xo',
          '--search',
          `${woId} in:title`,
          '--state',
          'all',
          '--limit',
          '50',
          '--json',
          'number,title',
        ],
        { cwd }
      );
      if (listed.code !== 0) {
        getLog().warn({ runId, woId }, 'cursor_cloud.tracker_comment_skipped');
        return;
      }
      const matches = issueMatches(listed.stdout, woId);
      if (matches.length !== 1) {
        getLog().warn(
          { runId, woId, matchCount: matches.length },
          'cursor_cloud.tracker_comment_skipped'
        );
        return;
      }
      const number = matches[0]?.number;
      if (number === undefined) return;
      const viewed = await this.gh(
        [
          'gh',
          'api',
          '--method',
          'GET',
          `repos/thinmansoftware/bdc-xo/issues/${String(number)}/comments`,
        ],
        { cwd }
      );
      if (viewed.code !== 0) {
        getLog().warn({ runId, woId }, 'cursor_cloud.tracker_comment_skipped');
        return;
      }
      if (commentBodies(viewed.stdout).some(body => body.includes(marker))) {
        binding.commentPosted = true;
        return;
      }
      const body = [`WO ${woId}`, `Cauldron run ${runId}`, binding.url, marker].join('\n');
      const posted = await this.gh(
        [
          'gh',
          'issue',
          'comment',
          String(number),
          '--repo',
          'thinmansoftware/bdc-xo',
          '--body',
          body,
        ],
        { cwd }
      );
      if (posted.code !== 0) {
        getLog().warn({ runId, woId }, 'cursor_cloud.tracker_comment_failed');
        return;
      }
      binding.commentPosted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'tracker comment failed';
      getLog().warn(
        { runId, woId, error: redact(message, key) },
        'cursor_cloud.tracker_comment_failed'
      );
    }
  }

  private async *poll(
    client: CursorCloudAgentClient,
    binding: CloudBinding,
    cloudRunId: string,
    cwd: string,
    branch: string,
    preDispatchSha: string,
    key: string,
    signal?: AbortSignal
  ): AsyncGenerator<MessageChunk> {
    let seen = '';
    for (;;) {
      if (signal?.aborted) {
        yield* this.cancel(client, binding.agentId, cloudRunId, key);
        return;
      }
      let run: CursorCloudRunRecord;
      try {
        run = await client.getRun(binding.agentId, cloudRunId);
      } catch (err) {
        throw this.fail(err instanceof Error ? err.message : 'cursor-cloud poll failed', key);
      }
      const stamp = `${run.status}\n${run.updatedAt ?? ''}`;
      if (stamp !== seen) {
        seen = stamp;
        yield {
          type: 'assistant',
          content: `cursor-cloud run ${run.id} status=${run.status} updatedAt=${run.updatedAt ?? ''}`,
        };
      }
      if (run.status === 'FINISHED') {
        const sha = await this.verifyHead(cwd, branch, preDispatchSha, key);
        yield { type: 'assistant', content: `CURSOR_CLOUD_HEAD_VERIFIED=${sha}` };
        return;
      }
      if (TERMINAL_FAILURE.has(run.status)) {
        throw this.fail(`cursor-cloud run status ${run.status} agent ${binding.agentId}`, key);
      }
      await this.sleepImpl(POLL_INTERVAL_MS, signal);
    }
  }

  private async *cancel(
    client: CursorCloudAgentClient,
    agentId: string,
    cloudRunId: string,
    key: string
  ): AsyncGenerator<MessageChunk> {
    try {
      await client.cancelRun(agentId, cloudRunId);
    } catch (err) {
      throw this.fail(err instanceof Error ? err.message : 'cursor-cloud cancel failed', key);
    }
    let after: CursorCloudRunRecord;
    try {
      after = await client.getRun(agentId, cloudRunId);
    } catch (err) {
      throw this.fail(
        err instanceof Error ? err.message : 'cursor-cloud cancel confirm failed',
        key
      );
    }
    if (!TERMINAL_ANY.has(after.status)) {
      throw this.fail(
        `cursor-cloud cancel did not reach a terminal status ${after.status} agent ${agentId}`,
        key
      );
    }
    yield { type: 'assistant', content: `CURSOR_CLOUD_CANCELLED=${cloudRunId}` };
  }

  private async verifyHead(
    cwd: string,
    branch: string,
    preDispatchSha: string,
    key: string
  ): Promise<string> {
    const fetched = await this.gitResult(cwd, ['fetch', 'origin', branch]);
    if (fetched.code !== 0) {
      throw this.fail('CURSOR_CLOUD_HEAD_MISSING', key);
    }
    const tip = await this.gitResult(cwd, ['rev-parse', `origin/${branch}`]);
    if (tip.code !== 0 || !tip.stdout) {
      throw this.fail('CURSOR_CLOUD_HEAD_MISSING', key);
    }
    const ancestor = await this.gitResult(cwd, [
      'merge-base',
      '--is-ancestor',
      preDispatchSha,
      tip.stdout,
    ]);
    if (ancestor.code !== 0) {
      throw this.fail('CURSOR_CLOUD_HEAD_DIVERGED', key);
    }
    const merged = await this.gitResult(cwd, ['merge', '--ff-only', tip.stdout]);
    if (merged.code !== 0) {
      throw this.fail('CURSOR_CLOUD_HEAD_DIVERGED', key);
    }
    const head = await this.gitStdout(cwd, ['rev-parse', 'HEAD'], key);
    if (head !== tip.stdout) {
      throw this.fail('CURSOR_CLOUD_HEAD_DIVERGED', key);
    }
    return head;
  }
}

function issueMatches(stdout: string, woId: string): { number: number; title: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const matches: { number: number; title: string }[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as { number?: unknown; title?: unknown };
    if (typeof record.number !== 'number' || typeof record.title !== 'string') continue;
    if (!record.title.includes(woId)) continue;
    matches.push({ number: record.number, title: record.title });
  }
  return matches;
}

function commentBodies(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const bodies: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const body = (item as { body?: unknown }).body;
    if (typeof body === 'string') bodies.push(body);
  }
  return bodies;
}
