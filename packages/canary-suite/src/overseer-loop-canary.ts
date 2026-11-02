import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { access, link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_24H_MS = DAY_MS;
const WINDOW_7D_MS = 7 * DAY_MS;
const EVIDENCE_LIMIT = 500;
const REVIEW_LIMIT = 20;
const PR_DISCOVERY_PREFIX = 'pr-discovery:';
const REMEDIATION_KIND = 'overseer_remediation_candidate';
const SPEC_GAP_MARKER = 'SPEC_GAP:';
const DEFAULT_WEBHOOK_URL = 'https://n8n.bluedevilcollectibles.com/webhook/builder-status';
const DEFAULT_POLL_MS = 15_000;
const VALIDATE_RELATIVE = 'scripts/cauldron/validate-wo-spec.sh';
const FIRE_RELATIVE = 'scripts/cauldron/fire.ps1';

export const OVERSEER_LOOP_CANARY_REPO = 'thinmansoftware/bdc-harness';
export const OVERSEER_LOOP_CANARY_BASE = 'dev';
export const OVERSEER_LOOP_CANARY_BRANCH = 'canary/overseer-loop';
export const OVERSEER_LOOP_CANARY_PATH = 'docs/canary/overseer-loop-canary.txt';

const DEFAULT_BUDGETS = {
  prOpenMs: 30 * 60 * 1000,
  approvalMs: 30 * 60 * 1000,
  mergeMs: 15 * 60 * 1000,
} as const;

const REVIEWED_MARKER = /Reviewed against WO-[A-Za-z0-9-]+ @ [0-9a-f]{7,40}/;
const NO_SPEC_MARKER = /No WO spec found \([^)]+\)/;
const NAIVE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

export type OverseerLoopVerdict = 'PASS' | 'WARN' | 'FAIL';
export type OverseerLoopCheckName = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7';

export interface OverseerLoopCheck {
  readonly name: OverseerLoopCheckName;
  readonly verdict: OverseerLoopVerdict;
  readonly evidence: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

export interface OverseerLoopReport {
  readonly invocation: 'daily' | 'since-rebuild';
  readonly verdict: OverseerLoopVerdict;
  readonly checks: readonly OverseerLoopCheck[];
  readonly digest: string;
  readonly alertNotes: readonly string[];
  readonly artifactPaths: readonly string[];
}

interface Query<T> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
}

export interface OverseerLoopDatabase {
  query<T>(sql: string): Query<T>;
}

export class OverseerLoopDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverseerLoopDatabaseError';
  }
}

export interface CanaryForgeTarget {
  readonly repo: string;
  readonly base: string;
}

export interface CanaryPullRequest {
  readonly number: number;
  readonly headSha: string;
}

export interface OverseerLoopForge {
  resolveTarget(): Promise<CanaryForgeTarget>;
  findOpenPullRequest(): Promise<CanaryPullRequest | null>;
  publishCanaryFile(line: string): Promise<{ headSha: string; prNumber: number }>;
  findApproval(
    prNumber: number,
    headSha: string
  ): Promise<{ approved: boolean; at: string | null }>;
  findMerge(prNumber: number): Promise<{ merged: boolean; at: string | null }>;
  closePullRequest(prNumber: number): Promise<void>;
  deleteBranch(): Promise<void>;
}

export interface ScriptRunRequest {
  readonly script: 'validate-wo-spec.sh' | 'fire.ps1';
  readonly fixturePath: string;
  readonly argv: readonly string[];
}

export interface ScriptRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ScriptRunner = (request: ScriptRunRequest) => Promise<ScriptRunResult>;

export interface ReviewBody {
  readonly id: string;
  readonly body: string;
}

export interface EscalatePayload {
  readonly action: 'escalate_xo';
  readonly canary: string;
  readonly evidence: readonly string[];
  readonly summary_path: string;
}

export interface DispatchPayload {
  readonly correlation_id: string;
  readonly idempotency_key: string;
  readonly task_type: 'agent_message';
  readonly sender: 'overseer-loop-canary';
  readonly recipient: 'operator' | 'duty-officer';
  readonly priority: 'blocker' | 'normal';
  readonly body: string;
}

export interface AlertTransport {
  postWebhook(url: string, payload: EscalatePayload): Promise<void>;
  postDispatch(url: string, payload: DispatchPayload, token: string): Promise<void>;
}

export interface C3Budgets {
  readonly prOpenMs: number;
  readonly approvalMs: number;
  readonly mergeMs: number;
}

export interface OverseerLoopDeps {
  readonly dbPath?: string;
  readonly db?: OverseerLoopDatabase;
  readonly outputRoot?: string;
  readonly summaryPath?: string;
  readonly now?: () => number;
  readonly invocation?: 'daily' | 'since-rebuild';
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly branchIdentityLanded?: boolean;
  readonly reviewSpecLanded?: boolean;
  readonly handbackLanded?: boolean;
  readonly forge?: OverseerLoopForge;
  readonly ghAvailable?: () => boolean;
  readonly scriptRunner?: ScriptRunner;
  readonly loadReviewBodies?: (db: OverseerLoopDatabase) => Promise<readonly ReviewBody[]>;
  readonly fixtureDir?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly budgets?: C3Budgets;
  readonly operatorToken?: string;
  readonly dispatchBaseUrl?: string;
  readonly webhookUrl?: string;
  readonly alertTransport?: AlertTransport;
  readonly dutyOfficer?: (digest: string) => Promise<void>;
}

interface WorkflowRunRow {
  readonly id: string;
  readonly started_at: string | null;
  readonly metadata: string | null;
}

interface ActionRow {
  readonly run_id: string;
  readonly action: string;
  readonly result: string;
  readonly created_at: string | null;
}

interface VerdictWindowRow {
  readonly id: string;
  readonly wo_id: string;
  readonly head_sha: string;
  readonly status: string;
  readonly verdict: string | null;
  readonly created_at: string | null;
}

interface VerdictBodyRow {
  readonly id: string;
  readonly reason: string | null;
  readonly evidence: string | null;
}

interface DispatchMessageRow {
  readonly recipient: string;
  readonly body: string;
  readonly created_at: string | null;
}

type StampClass = 'in' | 'out' | 'bad';

function clip(value: string): string {
  return value.length <= EVIDENCE_LIMIT ? value : value.slice(0, EVIDENCE_LIMIT);
}

function check(
  name: OverseerLoopCheckName,
  verdict: OverseerLoopVerdict,
  evidence: readonly string[],
  counts: Readonly<Record<string, number>>
): OverseerLoopCheck {
  return { name, verdict, evidence: evidence.map(clip), counts };
}

function nowMs(deps: OverseerLoopDeps): number {
  return (deps.now ?? Date.now)();
}

function flagOn(deps: OverseerLoopDeps, envName: string, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return deps.env?.[envName] === '1';
}

function parseEventTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const naive = NAIVE_TIMESTAMP.exec(trimmed);
  if (naive) {
    const parsed = Date.parse(`${naive[1]}T${naive[2]}Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function classifyTimestamp(raw: string, now: number, windowMs: number): StampClass {
  const parsed = parseEventTimestamp(raw);
  if (parsed === null) return 'bad';
  if (parsed >= now - windowMs && parsed <= now) return 'in';
  return 'out';
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function branchMissing(metadata: Record<string, unknown> | null, key: string): boolean {
  if (!metadata) return true;
  const value = metadata[key];
  return typeof value !== 'string' || value.trim() === '';
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function dispatchUrl(base: string): string {
  return `${base.replace(/\/$/, '')}/api/dispatch/messages`;
}

function aggregate(checks: readonly OverseerLoopCheck[]): OverseerLoopVerdict {
  if (checks.some(item => item.verdict === 'FAIL')) return 'FAIL';
  if (checks.some(item => item.verdict === 'WARN')) return 'WARN';
  return 'PASS';
}

export function openOverseerLoopDatabase(dbPath: string): {
  db: OverseerLoopDatabase;
  close: () => void;
} {
  const raw = new Database(dbPath, { readonly: true });
  return {
    // The returned surface is query-only. run, exec, and prepare stay on the
    // raw handle and are not copied onto this object.
    db: {
      query<T>(sql: string): Query<T> {
        const statement = raw.query(sql);
        return {
          all: (...params: unknown[]): T[] => statement.all(...(params as never[])) as T[],
          get: (...params: unknown[]): T | null =>
            (statement.get(...(params as never[])) as T | null) ?? null,
        };
      },
    },
    close: (): void => {
      raw.close();
    },
  };
}

function openFromDeps(deps: OverseerLoopDeps): { db: OverseerLoopDatabase; close: () => void } {
  if (deps.db) return { db: deps.db, close: (): void => undefined };
  if (!deps.dbPath) throw new OverseerLoopDatabaseError('overseer_loop_db_path_required');
  try {
    return openOverseerLoopDatabase(deps.dbPath);
  } catch (error) {
    if (error instanceof OverseerLoopDatabaseError) throw error;
    throw new OverseerLoopDatabaseError(`overseer_loop_db_unreadable:${(error as Error).message}`);
  }
}

function useDatabase<T>(deps: OverseerLoopDeps, read: (db: OverseerLoopDatabase) => T): T {
  const opened = openFromDeps(deps);
  try {
    return read(opened.db);
  } finally {
    opened.close();
  }
}

export async function runC1RunBranchIdentity(deps: OverseerLoopDeps): Promise<OverseerLoopCheck> {
  try {
    return useDatabase(deps, db => {
      const rows = db
        .query<WorkflowRunRow>('SELECT id, started_at, metadata FROM remote_agent_workflow_runs')
        .all();
      const current = nowMs(deps);
      const evidence: string[] = [];
      let missing = 0;
      for (const row of rows) {
        const stamp = classifyTimestamp(row.started_at ?? '', current, WINDOW_24H_MS);
        if (stamp === 'bad') {
          evidence.push(`unparseable_timestamp=${row.started_at ?? ''}`);
          continue;
        }
        if (stamp !== 'in') continue;
        if (
          branchMissing(parseMetadata(row.metadata), 'base_branch') ||
          branchMissing(parseMetadata(row.metadata), 'head_branch')
        ) {
          missing += 1;
          evidence.push(`missing_run=${row.id}`);
        }
      }
      const landed = flagOn(
        deps,
        'OVERSEER_CANARY_BRANCH_IDENTITY_LANDED',
        deps.branchIdentityLanded
      );
      const verdict: OverseerLoopVerdict = missing === 0 ? 'PASS' : landed ? 'FAIL' : 'WARN';
      return check('C1', verdict, evidence, { missing });
    });
  } catch (error) {
    return check('C1', 'FAIL', [`error=${(error as Error).message}`], {});
  }
}

export async function runC2OverseerMergeHealth(deps: OverseerLoopDeps): Promise<OverseerLoopCheck> {
  try {
    return useDatabase(deps, db => {
      const rows = db
        .query<ActionRow>('SELECT run_id, action, result, created_at FROM overseer_actions')
        .all();
      const current = nowMs(deps);
      const evidence: string[] = [];
      const denied = new Map<string, number>();
      let ready = 0;
      let runDerivedMerged = 0;
      for (const row of rows) {
        const stamp = classifyTimestamp(row.created_at ?? '', current, WINDOW_24H_MS);
        if (stamp === 'bad') {
          evidence.push(`unparseable_timestamp=${row.created_at ?? ''}`);
          continue;
        }
        if (stamp !== 'in') continue;
        if (row.action === 'merge_denied') {
          denied.set(row.result, (denied.get(row.result) ?? 0) + 1);
        } else if (row.action === 'flag_merge_ready') {
          ready += 1;
        } else if (row.action === 'merged' && !row.run_id.startsWith(PR_DISCOVERY_PREFIX)) {
          runDerivedMerged += 1;
        }
      }
      const repeated = [...denied.entries()]
        .filter(([, count]) => count >= 3)
        .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
      for (const [result, count] of repeated) {
        evidence.push(`repeated_result=${result} count=${count}`);
      }
      const readyGap = ready > 0 && runDerivedMerged === 0;
      if (readyGap) evidence.push(`flag_merge_ready=${ready} run_derived_merged=0`);
      const maxDenied = Math.max(0, ...denied.values());
      const verdict: OverseerLoopVerdict = repeated.length > 0 || readyGap ? 'FAIL' : 'PASS';
      return check('C2', verdict, evidence, {
        merge_denied_max: maxDenied,
        flag_merge_ready: ready,
        run_derived_merged: runDerivedMerged,
      });
    });
  } catch (error) {
    return check('C2', 'FAIL', [`error=${(error as Error).message}`], {});
  }
}

class TargetRefusedError extends Error {
  constructor() {
    super('target_refused');
    this.name = 'TargetRefusedError';
  }
}

async function targetAllowed(forge: OverseerLoopForge): Promise<boolean> {
  const target = await forge.resolveTarget();
  return target.repo === OVERSEER_LOOP_CANARY_REPO && target.base === OVERSEER_LOOP_CANARY_BASE;
}

async function requireTarget(forge: OverseerLoopForge): Promise<void> {
  if (!(await targetAllowed(forge))) throw new TargetRefusedError();
}

async function pollStep(
  budgetMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  probe: () => Promise<string | null>
): Promise<string | null> {
  const start = now();
  for (let spins = 0; spins < 10_000; spins += 1) {
    const hit = await probe();
    if (hit) return hit;
    if (now() - start >= budgetMs) return null;
    const before = now();
    await sleep(intervalMs);
    if (now() <= before) return null;
    if (now() - start >= budgetMs) return null;
  }
  return null;
}

async function cleanupCanaryPullRequest(
  forge: OverseerLoopForge,
  prNumber: number,
  evidence: string[]
): Promise<void> {
  try {
    await requireTarget(forge);
    await forge.closePullRequest(prNumber);
    await requireTarget(forge);
    await forge.deleteBranch();
  } catch (error) {
    if (error instanceof TargetRefusedError) {
      evidence.push('target_refused');
      return;
    }
    evidence.push(`cleanup_error=${(error as Error).message}`);
  }
}

function ghForge(): OverseerLoopForge {
  return {
    resolveTarget(): Promise<CanaryForgeTarget> {
      return Promise.resolve({
        repo: OVERSEER_LOOP_CANARY_REPO,
        base: OVERSEER_LOOP_CANARY_BASE,
      });
    },
    async findOpenPullRequest(): Promise<CanaryPullRequest | null> {
      const rows = await ghJson<{ number?: number; headRefOid?: string }[]>([
        'pr',
        'list',
        '--repo',
        OVERSEER_LOOP_CANARY_REPO,
        '--head',
        OVERSEER_LOOP_CANARY_BRANCH,
        '--base',
        OVERSEER_LOOP_CANARY_BASE,
        '--state',
        'open',
        '--json',
        'number,headRefOid',
      ]);
      const first = rows.find(row => typeof row.number === 'number');
      if (!first || typeof first.number !== 'number') return null;
      return { number: first.number, headSha: first.headRefOid ?? '' };
    },
    async publishCanaryFile(line: string): Promise<{ headSha: string; prNumber: number }> {
      const headSha = await publishCanaryFileWithGh(line);
      let open = await this.findOpenPullRequest();
      if (!open) {
        const created = await execGh([
          'pr',
          'create',
          '--repo',
          OVERSEER_LOOP_CANARY_REPO,
          '--base',
          OVERSEER_LOOP_CANARY_BASE,
          '--head',
          OVERSEER_LOOP_CANARY_BRANCH,
          '--title',
          'canary: overseer-loop',
          '--body',
          'Automated overseer-loop canary. Changes only docs/canary/overseer-loop-canary.txt.',
        ]);
        if (created.exitCode !== 0) {
          throw new Error(`gh_exit=${created.exitCode}:${created.stderr.trim()}`);
        }
        open = await this.findOpenPullRequest();
      }
      if (!open) throw new Error('gh_missing_canary_pr');
      return { headSha, prNumber: open.number };
    },
    async findApproval(
      prNumber: number,
      headSha: string
    ): Promise<{ approved: boolean; at: string | null }> {
      const reviews = await ghJson<{ state?: string; commit_id?: string; submitted_at?: string }[]>(
        ['api', '--paginate', `repos/${OVERSEER_LOOP_CANARY_REPO}/pulls/${prNumber}/reviews`]
      );
      const match = reviews.find(
        review => review.state === 'APPROVED' && review.commit_id === headSha
      );
      return { approved: Boolean(match), at: match?.submitted_at ?? null };
    },
    async findMerge(prNumber: number): Promise<{ merged: boolean; at: string | null }> {
      const view = await ghJson<{ state?: string; mergedAt?: string | null }>([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        OVERSEER_LOOP_CANARY_REPO,
        '--json',
        'state,mergedAt',
      ]);
      const at = typeof view.mergedAt === 'string' && view.mergedAt ? view.mergedAt : null;
      return { merged: view.state === 'MERGED' || at !== null, at };
    },
    async closePullRequest(prNumber: number): Promise<void> {
      const closed = await execGh([
        'pr',
        'close',
        String(prNumber),
        '--repo',
        OVERSEER_LOOP_CANARY_REPO,
      ]);
      if (closed.exitCode !== 0)
        throw new Error(`gh_exit=${closed.exitCode}:${closed.stderr.trim()}`);
    },
    async deleteBranch(): Promise<void> {
      const encoded = OVERSEER_LOOP_CANARY_BRANCH.replaceAll('/', '%2F');
      const deleted = await execGh([
        'api',
        '--method',
        'DELETE',
        `repos/${OVERSEER_LOOP_CANARY_REPO}/git/refs/heads/${encoded}`,
      ]);
      if (deleted.exitCode !== 0) {
        throw new Error(`gh_exit=${deleted.exitCode}:${deleted.stderr.trim()}`);
      }
    },
  };
}

async function execGh(
  args: readonly string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stdout, stderr };
}

async function ghJson<T>(args: readonly string[]): Promise<T> {
  const result = await execGh(args);
  if (result.exitCode !== 0) {
    throw new Error(`gh_exit=${result.exitCode}:${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

async function publishCanaryFileWithGh(line: string): Promise<string> {
  const branchRef = await execGh([
    'api',
    `repos/${OVERSEER_LOOP_CANARY_REPO}/git/ref/heads/${OVERSEER_LOOP_CANARY_BRANCH}`,
  ]);
  if (branchRef.exitCode !== 0) {
    const base = await ghJson<{ object?: { sha?: string } }>([
      'api',
      `repos/${OVERSEER_LOOP_CANARY_REPO}/git/ref/heads/${OVERSEER_LOOP_CANARY_BASE}`,
    ]);
    const baseSha = base.object?.sha;
    if (!baseSha) throw new Error('gh_missing_base_sha');
    const created = await execGh([
      'api',
      '--method',
      'POST',
      `repos/${OVERSEER_LOOP_CANARY_REPO}/git/refs`,
      '-f',
      `ref=refs/heads/${OVERSEER_LOOP_CANARY_BRANCH}`,
      '-f',
      `sha=${baseSha}`,
    ]);
    if (created.exitCode !== 0) {
      throw new Error(`gh_exit=${created.exitCode}:${created.stderr.trim()}`);
    }
  }
  const existing = await execGh([
    'api',
    `repos/${OVERSEER_LOOP_CANARY_REPO}/contents/${OVERSEER_LOOP_CANARY_PATH}?ref=${OVERSEER_LOOP_CANARY_BRANCH}`,
  ]);
  let blobSha = '';
  if (existing.exitCode === 0) {
    const parsed = JSON.parse(existing.stdout) as { sha?: string };
    blobSha = parsed.sha ?? '';
  }
  const args = [
    'api',
    '--method',
    'PUT',
    `repos/${OVERSEER_LOOP_CANARY_REPO}/contents/${OVERSEER_LOOP_CANARY_PATH}`,
    '-f',
    'message=canary: overseer-loop timestamp',
    '-f',
    `content=${Buffer.from(line, 'utf8').toString('base64')}`,
    '-f',
    `branch=${OVERSEER_LOOP_CANARY_BRANCH}`,
  ];
  if (blobSha) args.push('-f', `sha=${blobSha}`);
  const put = await ghJson<{ commit?: { sha?: string } }>(args);
  const headSha = put.commit?.sha;
  if (!headSha) throw new Error('gh_missing_commit_sha');
  return headSha;
}

export async function runC3EndToEndMerge(deps: OverseerLoopDeps): Promise<OverseerLoopCheck> {
  try {
    const available = deps.ghAvailable ?? ((): boolean => Bun.which('gh') !== null);
    const forge = deps.forge ?? (available() ? ghForge() : null);
    if (!forge) return check('C3', 'FAIL', ['forge_unavailable'], {});
    const budgets = deps.budgets ?? DEFAULT_BUDGETS;
    const current = nowMs(deps);
    const clock = deps.now ?? ((): number => current);
    const sleep = deps.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
    const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    const evidence: string[] = [];
    await requireTarget(forge);
    const started = clock();
    await requireTarget(forge);
    const existing = await forge.findOpenPullRequest();
    await requireTarget(forge);
    const line = `${new Date(clock()).toISOString()}\n`;
    const published = await forge.publishCanaryFile(line);
    const prNumber = existing?.number ?? published.prNumber;
    if (clock() - started > budgets.prOpenMs) {
      await cleanupCanaryPullRequest(forge, prNumber, evidence);
      return check('C3', 'FAIL', [...evidence, 'failed_step=pr_open'], { pr_number: prNumber });
    }
    evidence.push(`pr_open=${new Date(clock()).toISOString()}`);
    const approvedAt = await pollStep(budgets.approvalMs, clock, sleep, intervalMs, async () => {
      await requireTarget(forge);
      const approval = await forge.findApproval(prNumber, published.headSha);
      return approval.approved ? (approval.at ?? new Date(clock()).toISOString()) : null;
    });
    if (!approvedAt) {
      await cleanupCanaryPullRequest(forge, prNumber, evidence);
      return check('C3', 'FAIL', [...evidence, 'failed_step=overseer_approval'], {
        pr_number: prNumber,
      });
    }
    evidence.push(`overseer_approval=${approvedAt}`);
    const mergedAt = await pollStep(budgets.mergeMs, clock, sleep, intervalMs, async () => {
      await requireTarget(forge);
      const merge = await forge.findMerge(prNumber);
      return merge.merged ? (merge.at ?? new Date(clock()).toISOString()) : null;
    });
    if (!mergedAt) {
      await cleanupCanaryPullRequest(forge, prNumber, evidence);
      return check('C3', 'FAIL', [...evidence, 'failed_step=merge_manager'], {
        pr_number: prNumber,
      });
    }
    evidence.push(`merge_manager=${mergedAt}`);
    return check('C3', 'PASS', evidence, { pr_number: prNumber });
  } catch (error) {
    if (error instanceof TargetRefusedError) return check('C3', 'FAIL', ['target_refused'], {});
    return check('C3', 'FAIL', [`error=${(error as Error).message}`], {});
  }
}

function fixtureDirectory(deps: OverseerLoopDeps): string {
  return deps.fixtureDir ?? join(import.meta.dir, '../fixtures/overseer-loop');
}

function commandArgv(override: string | undefined, fixturePath: string): string[] {
  if (override && override.trim() !== '') return override.trim().split(/\s+/);
  return [fixturePath];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function expectedTextUnverified(dir: string): Promise<boolean> {
  for (const name of ['c4-missing-base.expected.txt', 'c4-wrong-base.expected.txt']) {
    try {
      const text = await readFile(join(dir, name), 'utf8');
      if (text.includes(SPEC_GAP_MARKER)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function spawnChecked(command: string, args: readonly string[]): Promise<ScriptRunResult> {
  const proc = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stdout, stderr };
}

const C4_FIXTURES = [
  { file: 'c4-missing-base.md', expectFile: 'c4-missing-base.expected.txt', wantRefuse: true },
  { file: 'c4-wrong-base.md', expectFile: 'c4-wrong-base.expected.txt', wantRefuse: true },
  { file: 'c4-correct-base.md', expectFile: null, wantRefuse: false },
] as const;

async function evaluateC4Fixtures(
  deps: OverseerLoopDeps,
  runner: ScriptRunner
): Promise<OverseerLoopCheck> {
  const dir = fixtureDirectory(deps);
  const env = deps.env ?? {};
  const failures: string[] = [];
  for (const fixture of C4_FIXTURES) {
    const fixturePath = join(dir, fixture.file);
    const scripts = ['validate-wo-spec.sh', 'fire.ps1'] as const;
    for (const script of scripts) {
      const argv = commandArgv(
        script === 'validate-wo-spec.sh'
          ? env.OVERSEER_CANARY_VALIDATE_ARGV
          : env.OVERSEER_CANARY_FIRE_ARGV,
        fixturePath
      );
      const result = await runner({ script, fixturePath, argv });
      if (fixture.wantRefuse) {
        const expected = (await readFile(join(dir, fixture.expectFile ?? ''), 'utf8')).trim();
        if (!expected || result.exitCode === 0 || !result.stderr.includes(expected)) {
          failures.push(`${fixture.file}:${script}`);
        }
      } else if (result.exitCode !== 0) {
        failures.push(`${fixture.file}:${script}`);
      }
    }
  }
  if (failures.length > 0) {
    return check(
      'C4',
      'FAIL',
      failures.map(item => `fixture_failed=${item}`),
      { checked: C4_FIXTURES.length, failed: failures.length }
    );
  }
  return check('C4', 'PASS', ['missing_base=refused wrong_base=refused correct_base=accepted'], {
    checked: C4_FIXTURES.length,
    failed: 0,
  });
}

export async function runC4SpecBaseBranchGate(deps: OverseerLoopDeps): Promise<OverseerLoopCheck> {
  try {
    if (!deps.scriptRunner) {
      const dir = fixtureDirectory(deps);
      if (await expectedTextUnverified(dir)) {
        return check('C4', 'FAIL', ['c4_expected_text_unverified'], {
          checked: C4_FIXTURES.length,
        });
      }
      const validatePath = join(process.cwd(), VALIDATE_RELATIVE);
      const firePath = join(process.cwd(), FIRE_RELATIVE);
      if (!(await pathExists(validatePath)) || !(await pathExists(firePath))) {
        return check('C4', 'FAIL', ['c4_expected_text_unverified'], {
          checked: C4_FIXTURES.length,
        });
      }
      if (Bun.which('pwsh') === null) {
        return check('C4', 'FAIL', ['fire_ps1_host_missing'], { checked: C4_FIXTURES.length });
      }
      return await evaluateC4Fixtures(deps, async request => {
        if (request.script === 'validate-wo-spec.sh') {
          return spawnChecked('bash', [validatePath, ...request.argv]);
        }
        return spawnChecked('pwsh', [firePath, ...request.argv]);
      });
    }
    return await evaluateC4Fixtures(deps, deps.scriptRunner);
  } catch (error) {
    return check('C4', 'FAIL', [`error=${(error as Error).message}`], {});
  }
}

function bodyHasSpecMarker(body: string): boolean {
  return REVIEWED_MARKER.test(body) || NO_SPEC_MARKER.test(body);
}

async function defaultReviewBodies(db: OverseerLoopDatabase): Promise<readonly ReviewBody[]> {
  const rows = db
    .query<VerdictBodyRow>(
      `SELECT id, reason, evidence FROM overseer_verdicts
       WHERE status = 'verdict' ORDER BY created_at DESC LIMIT ${REVIEW_LIMIT}`
    )
    .all();
  return rows.map(row => ({
    id: row.id,
    body: [row.reason ?? '', row.evidence ?? ''].filter(part => part !== '').join('\n'),
  }));
}

function emptyQueryDatabase(): OverseerLoopDatabase {
  return {
    query: <T>(): Query<T> => ({
      all: (): T[] => [],
      get: (): T | null => null,
    }),
  };
}

export async function runC5ReviewerHasSpec(deps: OverseerLoopDeps): Promise<OverseerLoopCheck> {
  try {
    const bodies = (
      deps.loadReviewBodies
        ? await deps.loadReviewBodies(deps.db ?? emptyQueryDatabase())
        : await useDatabase(deps, defaultReviewBodies)
    ).slice(0, REVIEW_LIMIT);
    if (bodies.length === 0) {
      return check('C5', 'WARN', ['review_count=0'], { review_count: 0, missing: 0 });
    }
    const missing = bodies.filter(body => !bodyHasSpecMarker(body.body));
    const landed = flagOn(deps, 'OVERSEER_CANARY_REVIEW_SPEC_LANDED', deps.reviewSpecLanded);
    const verdict: OverseerLoopVerdict = missing.length === 0 ? 'PASS' : landed ? 'FAIL' : 'WARN';
    return check(
      'C5',
      verdict,
      missing.map(body => `review_id=${body.id}`),
      { review_count: bodies.length, missing: missing.length }
    );
  } catch (error) {
    return check('C5', 'FAIL', [`error=${(error as Error).message}`], {});
  }
}

function candidateMatches(body: string, verdict: VerdictWindowRow): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== REMEDIATION_KIND) return false;
  if (typeof record.woId !== 'string' || record.woId.trim() === '') return false;
  if (record.woId !== verdict.wo_id) return false;
  if (
    typeof record.headSha === 'string' &&
    record.headSha.trim() !== '' &&
    verdict.head_sha.trim() !== '' &&
    record.headSha !== verdict.head_sha
  ) {
    return false;
  }
  return true;
}

export async function runC6FixLoopHealth(deps: OverseerLoopDeps): Promise<OverseerLoopCheck> {
  try {
    return useDatabase(deps, db => {
      const current = nowMs(deps);
      const verdicts = db
        .query<VerdictWindowRow>(
          'SELECT id, wo_id, head_sha, status, verdict, created_at FROM overseer_verdicts'
        )
        .all();
      const messages = db
        .query<DispatchMessageRow>(
          'SELECT recipient, body, created_at FROM agent_dispatch_messages'
        )
        .all();
      const runs = db
        .query<WorkflowRunRow>('SELECT id, started_at, metadata FROM remote_agent_workflow_runs')
        .all();
      const cohort = verdicts.filter(row => {
        if (row.status !== 'verdict' || row.verdict !== 'CHANGES_REQUESTED') return false;
        return classifyTimestamp(row.created_at ?? '', current, WINDOW_24H_MS) === 'in';
      });
      const inWindowMessages = messages.filter(
        row =>
          row.recipient === 'taskmaster' &&
          classifyTimestamp(row.created_at ?? '', current, WINDOW_24H_MS) === 'in'
      );
      const handRuns = runs.filter(
        row => classifyTimestamp(row.started_at ?? '', current, WINDOW_24H_MS) === 'in'
      );
      let automatic = 0;
      let hand = 0;
      for (const verdict of cohort) {
        const auto = inWindowMessages.some(message => candidateMatches(message.body, verdict));
        if (auto) {
          automatic += 1;
          continue;
        }
        const woId = verdict.wo_id.trim();
        if (!woId) continue;
        const hasHandRun = handRuns.some(run => {
          const metadata = parseMetadata(run.metadata);
          return typeof metadata?.wo_id === 'string' && metadata.wo_id === woId;
        });
        if (hasHandRun) hand += 1;
      }
      const handback = flagOn(deps, 'OVERSEER_CANARY_HANDBACK_LANDED', deps.handbackLanded);
      return check(
        'C6',
        'WARN',
        [`automatic=${automatic} hand=${hand} handback_landed=${handback ? 1 : 0}`],
        { automatic, hand }
      );
    });
  } catch (error) {
    return check('C6', 'FAIL', [`error=${(error as Error).message}`], {});
  }
}

export async function runC7RepeatedRefusalTripwire(
  deps: OverseerLoopDeps
): Promise<OverseerLoopCheck> {
  try {
    return useDatabase(deps, db => {
      const rows = db
        .query<ActionRow>('SELECT run_id, action, result, created_at FROM overseer_actions')
        .all();
      const current = nowMs(deps);
      const evidence: string[] = [];
      const counts = new Map<string, number>();
      for (const row of rows) {
        const stamp = classifyTimestamp(row.created_at ?? '', current, WINDOW_7D_MS);
        if (stamp === 'bad') {
          evidence.push(`unparseable_timestamp=${row.created_at ?? ''}`);
          continue;
        }
        if (stamp !== 'in') continue;
        counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
      }
      const tripped = [...counts.entries()]
        .filter(([, count]) => count >= 10)
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
      const digestLines = tripped.map(([result, count]) => `digest: ${result} count=${count}`);
      return check('C7', digestLines.length > 0 ? 'WARN' : 'PASS', [...digestLines, ...evidence], {
        tripped: digestLines.length,
      });
    });
  } catch (error) {
    return check('C7', 'FAIL', [`error=${(error as Error).message}`], {});
  }
}

const CANARIES: readonly {
  name: OverseerLoopCheckName;
  run: (deps: OverseerLoopDeps) => Promise<OverseerLoopCheck>;
}[] = [
  { name: 'C1', run: runC1RunBranchIdentity },
  { name: 'C2', run: runC2OverseerMergeHealth },
  { name: 'C3', run: runC3EndToEndMerge },
  { name: 'C4', run: runC4SpecBaseBranchGate },
  { name: 'C5', run: runC5ReviewerHasSpec },
  { name: 'C6', run: runC6FixLoopHealth },
  { name: 'C7', run: runC7RepeatedRefusalTripwire },
];

export function formatDutyOfficerDigest(report: {
  readonly invocation: 'daily' | 'since-rebuild';
  readonly checks: readonly { readonly verdict: OverseerLoopVerdict }[];
}): string {
  const fail = report.checks.filter(item => item.verdict === 'FAIL').length;
  const warn = report.checks.filter(item => item.verdict === 'WARN').length;
  const pass = report.checks.filter(item => item.verdict === 'PASS').length;
  const invocation = report.invocation === 'since-rebuild' ? 'since-rebuild' : 'daily';
  return `overseer-loop FAIL=${fail} WARN=${warn} PASS=${pass} invocation=${invocation}`;
}

function defaultTransport(): AlertTransport {
  return {
    async postWebhook(url: string, payload: EscalatePayload): Promise<void> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`webhook_http=${response.status}`);
    },
    async postDispatch(url: string, payload: DispatchPayload, token: string): Promise<void> {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-archon-operator-token': token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`dispatch_http=${response.status}`);
    },
  };
}

export async function fanOutFailAlerts(
  report: Pick<OverseerLoopReport, 'checks'>,
  deps: OverseerLoopDeps
): Promise<readonly string[]> {
  const notes: string[] = [];
  const failures = report.checks.filter(item => item.verdict === 'FAIL');
  const webhookUrl = deps.webhookUrl === undefined ? DEFAULT_WEBHOOK_URL : deps.webhookUrl;
  const token = deps.operatorToken ?? '';
  const dispatchBase = deps.dispatchBaseUrl ?? '';
  const summaryPath = deps.summaryPath ?? '';
  const day = utcDay(nowMs(deps));
  const transport = deps.alertTransport ?? defaultTransport();
  for (const failed of failures) {
    const evidence = failed.evidence.map(clip);
    if (!webhookUrl) {
      notes.push('alert_not_configured');
    } else {
      try {
        await transport.postWebhook(webhookUrl, {
          action: 'escalate_xo',
          canary: failed.name,
          evidence,
          summary_path: summaryPath,
        });
      } catch (error) {
        notes.push(clip(`alert_post_failed=${(error as Error).message}`));
      }
    }
    if (!dispatchBase || !token) {
      notes.push('alert_not_configured');
    } else {
      const key = `overseer-loop:${failed.name}:${day}`;
      try {
        await transport.postDispatch(
          dispatchUrl(dispatchBase),
          {
            correlation_id: key,
            idempotency_key: key,
            task_type: 'agent_message',
            sender: 'overseer-loop-canary',
            recipient: 'operator',
            priority: 'blocker',
            body: clip(
              JSON.stringify({ canary: failed.name, evidence, summary_path: summaryPath })
            ),
          },
          token
        );
      } catch (error) {
        notes.push(clip(`alert_post_failed=${(error as Error).message}`));
      }
    }
  }
  return notes;
}

export function createDutyOfficerSender(deps: OverseerLoopDeps): (digest: string) => Promise<void> {
  return async (digest: string): Promise<void> => {
    const base = deps.dispatchBaseUrl ?? '';
    const token = deps.operatorToken ?? '';
    if (!base || !token) return;
    const key = `overseer-loop:digest:${utcDay(nowMs(deps))}`;
    const transport = deps.alertTransport ?? defaultTransport();
    await transport.postDispatch(
      dispatchUrl(base),
      {
        correlation_id: key,
        idempotency_key: key,
        task_type: 'agent_message',
        sender: 'overseer-loop-canary',
        recipient: 'duty-officer',
        priority: 'normal',
        body: digest,
      },
      token
    );
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((await readIfPresent(path)) !== content) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function renderMarkdown(report: OverseerLoopReport): string {
  const lines = [
    '# Overseer loop canary',
    '',
    `Invocation: ${report.invocation}`,
    `Verdict: ${report.verdict}`,
    `Digest: ${report.digest}`,
    '',
  ];
  for (const item of report.checks) {
    lines.push(`## ${item.name}`, '');
    lines.push(`Verdict: ${item.verdict}`);
    const counts = Object.entries(item.counts)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    lines.push(`Counts: ${counts || 'none'}`);
    lines.push('Evidence:');
    if (item.evidence.length === 0) lines.push('- none');
    else for (const entry of item.evidence) lines.push(`- ${entry}`);
    lines.push('');
  }
  return lines.join('\n');
}

export async function writeOverseerLoopArtifacts(
  outputRoot: string,
  report: OverseerLoopReport
): Promise<string[]> {
  const directory = join(outputRoot, `overseer-loop-${randomUUID()}`);
  const jsonPath = join(directory, 'summary.json');
  const markdownPath = join(directory, 'summary.md');
  await mkdir(directory, { recursive: true });
  await writeExclusive(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeExclusive(markdownPath, renderMarkdown(report));
  return [jsonPath, markdownPath];
}

export async function runOverseerLoopCanaries(deps: OverseerLoopDeps): Promise<OverseerLoopReport> {
  const opened = openFromDeps(deps);
  try {
    const child: OverseerLoopDeps = { ...deps, db: opened.db };
    const checks: OverseerLoopCheck[] = [];
    for (const canary of CANARIES) {
      try {
        checks.push(await canary.run(child));
      } catch (error) {
        checks.push(check(canary.name, 'FAIL', [`error=${(error as Error).message}`], {}));
      }
    }
    const invocation = deps.invocation === 'since-rebuild' ? 'since-rebuild' : 'daily';
    const digest = formatDutyOfficerDigest({ invocation, checks });
    const preliminary: OverseerLoopReport = {
      invocation,
      verdict: aggregate(checks),
      checks,
      digest,
      alertNotes: [],
      artifactPaths: [],
    };
    const artifactPaths = deps.outputRoot
      ? await writeOverseerLoopArtifacts(deps.outputRoot, preliminary)
      : [];
    const summaryPath =
      artifactPaths.find(path => path.endsWith('summary.json')) ?? deps.summaryPath ?? '';
    const alertNotes = [...(await fanOutFailAlerts(preliminary, { ...deps, summaryPath }))];
    if (deps.dutyOfficer) {
      try {
        await deps.dutyOfficer(digest);
      } catch (error) {
        alertNotes.push(clip(`alert_post_failed=${(error as Error).message}`));
      }
    }
    return { ...preliminary, alertNotes, artifactPaths };
  } finally {
    opened.close();
  }
}
