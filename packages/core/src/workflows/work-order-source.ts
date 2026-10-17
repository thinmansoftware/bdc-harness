import { createHash } from 'crypto';
import type { RunAuthorityPolicy } from '@archon/workflows/schemas/workflow';
import type { FrozenSpecSource } from '@archon/workflows/reliability/run-authority';

export interface WorkOrderSourceDependencies {
  readonly fetcher?: typeof fetch;
  readonly githubToken?: string;
  /** Resolved execution repository, never the repository containing the spec. */
  readonly targetRepository?: string | null;
  /**
   * Resolve a repair-attempt dispatch row by id
   * (WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01). Wired to dispatch.getMessage.
   * When the frozen message carries a `repair_attempt=<id>` line, this is the
   * ONLY authority that can admit a "Repair target: PR #N (branch X)" line into
   * the frozen spec -- message text alone is never authority.
   */
  readonly lookupRepairAttempt?: (id: string) => Promise<RepairAttemptRow | null>;
}

/** The dispatch-row fields the repair-attempt authority check reads. */
export interface RepairAttemptRow {
  readonly sender: string;
  readonly sender_principal_id: string | null;
  readonly recipient: string;
  readonly body: string;
  readonly status: string;
  readonly addressed_at: string | null;
  readonly addressed_by: string | null;
  readonly route_disposition: string | null;
  readonly acknowledged_by: string | null;
  readonly acknowledged_at: string | Date | null;
}

const REPAIR_ATTEMPT_LINE_RE = /^repair_attempt=([A-Za-z0-9-]{8,64})$/;
const REPAIR_ACK_MAX_AGE_MS = 60 * 60 * 1000;

/** GitHub remote and owner/repo forms share the same case-insensitive identity. */
function repairRepository(value: string | null | undefined): string | null {
  if (!value) return null;
  const match =
    /^(?:(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/))?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      value.trim()
    );
  return match?.[1]?.toLowerCase() ?? null;
}

/** Shared by freezing and the atomic first-run authority transaction. */
export function validateRepairAttemptRow(
  row: RepairAttemptRow,
  frozenWoId: string,
  targetRepository: string | null | undefined
): { prNumber: number; headRef: string } {
  if (row.sender !== 'overseer' || row.sender_principal_id !== 'system:overseer') {
    throw new Error('authority_conflict: repair_attempt sender');
  }
  if (row.recipient !== 'taskmaster') {
    throw new Error('authority_conflict: repair_attempt recipient');
  }
  if (
    row.status !== 'queued' ||
    row.addressed_at !== null ||
    row.addressed_by !== null ||
    row.route_disposition !== null
  )
    throw new Error('authority_conflict: repair_attempt consumed or refused');
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    throw new Error('authority_conflict: repair_attempt body');
  }
  if (body.kind !== 'overseer_remediation_candidate') {
    throw new Error('authority_conflict: repair_attempt kind');
  }
  if (!Array.isArray(body.findingClasses) || !body.findingClasses.includes('lane_repair')) {
    throw new Error('authority_conflict: repair_attempt findingClasses');
  }
  if (body.woId !== frozenWoId) throw new Error('authority_conflict: repair_attempt woId');
  const actualRepository = repairRepository(targetRepository);
  if (
    typeof body.owner !== 'string' ||
    typeof body.repo !== 'string' ||
    !actualRepository ||
    `${body.owner}/${body.repo}`.toLowerCase() !== actualRepository
  )
    throw new Error('authority_conflict: repair_attempt repository');
  if (typeof body.headRef !== 'string' || !body.headRef) {
    throw new Error('authority_conflict: repair_attempt headRef');
  }
  if (
    typeof body.prNumber !== 'number' ||
    !Number.isSafeInteger(body.prNumber) ||
    body.prNumber < 1
  ) {
    throw new Error('authority_conflict: repair_attempt prNumber');
  }
  if (row.acknowledged_by !== 'taskmaster') {
    throw new Error('authority_conflict: repair_attempt not acknowledged by taskmaster');
  }
  const ackMs =
    row.acknowledged_at instanceof Date
      ? row.acknowledged_at.getTime()
      : row.acknowledged_at
        ? Date.parse(row.acknowledged_at)
        : NaN;
  const age = Date.now() - ackMs;
  if (!Number.isFinite(ackMs) || age < 0 || age > REPAIR_ACK_MAX_AGE_MS) {
    throw new Error('authority_conflict: repair_attempt acknowledgement stale');
  }
  return { prNumber: body.prNumber, headRef: body.headRef };
}

/**
 * Resolve the repair target from a trusted dispatch row, or null when the
 * message carries no repair_attempt line. Throws authority_conflict on any
 * failed requirement -- a repair target can NEVER come from message text alone.
 *
 * Runs strictly AFTER the expected-spec comparison on the canonical bytes, so
 * the appended "Repair target" line never participates in that hash check.
 */
async function resolveRepairTarget(
  userMessage: string,
  frozenWoId: string,
  dependencies: WorkOrderSourceDependencies
): Promise<{ prNumber: number; headRef: string; id: string } | null> {
  const lines = userMessage.split(/\r?\n/);
  let attemptId: string | null = null;
  // Line 1 is the policy header; a repair_attempt line is only honored after it.
  for (let i = 1; i < lines.length; i += 1) {
    const match = REPAIR_ATTEMPT_LINE_RE.exec(lines[i]);
    if (match) {
      attemptId = match[1];
      break;
    }
  }
  if (!attemptId) return null;

  if (!dependencies.lookupRepairAttempt) {
    throw new Error('authority_conflict: repair_attempt lookup unavailable');
  }
  const row = await dependencies.lookupRepairAttempt(attemptId);
  if (!row) throw new Error('authority_conflict: repair_attempt row not found');
  return {
    ...validateRepairAttemptRow(row, frozenWoId, dependencies.targetRepository),
    id: attemptId,
  };
}

/** A constraint on policy-resolved authority, never an alternate authority source. */
export interface ExpectedSpecIdentity {
  readonly specSource: string;
  readonly specRevision: string;
  readonly specHash: string;
}

function readExpectedSpecIdentity(userMessage: string): ExpectedSpecIdentity | undefined {
  const header = userMessage.split(/\r?\n/, 1)[0];
  if (!header.includes('--expected-spec')) return undefined;
  const match =
    /^(?:\/workflow run [A-Za-z0-9_-]+ )?WO_ID=WO-[A-Z0-9-]+ --project [A-Za-z0-9_.-]+ --expected-spec=([A-Za-z0-9_-]+)$/.exec(
      header
    );
  if (!match) throw new Error('authority_conflict: malformed expected spec header');
  try {
    const value: unknown = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) throw new Error();
    const identity = value as Record<string, unknown>;
    if (
      Object.keys(identity).length !== 3 ||
      typeof identity.specSource !== 'string' ||
      !identity.specSource ||
      typeof identity.specRevision !== 'string' ||
      !identity.specRevision ||
      typeof identity.specHash !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.specHash)
    )
      throw new Error();
    return identity as unknown as ExpectedSpecIdentity;
  } catch {
    throw new Error('authority_conflict: malformed expected spec identity');
  }
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) return {};
  const value: unknown = await response.json();
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readWoId(value: string): string | undefined {
  return /\bWO-[A-Z0-9-]+\b/.exec(value)?.[0];
}

function readIssueNumber(value: string): number | undefined {
  const raw = /\bissue=(\d+)\b/i.exec(value)?.[1];
  if (!raw) return undefined;
  const issueNumber = Number.parseInt(raw, 10);
  return Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : undefined;
}

async function freezeIssueSource(input: {
  repository: string;
  issueNumber: number;
  messageWoId?: string;
  fetcher: typeof fetch;
  headers: Record<string, string>;
}): Promise<FrozenSpecSource> {
  const response = await input.fetcher(
    `https://api.github.com/repos/${input.repository}/issues/${String(input.issueNumber)}`,
    { headers: input.headers }
  );
  const issue = await readJson(response);
  const title = typeof issue.title === 'string' ? issue.title : '';
  const body = typeof issue.body === 'string' ? issue.body : '';
  const updatedAt = typeof issue.updated_at === 'string' ? issue.updated_at : '';
  const woId = input.messageWoId ?? readWoId(`${title}\n${body}`);
  if (!woId) throw new Error('scope_authority_missing: woId');
  if (!body.trim() || !updatedAt) throw new Error('scope_authority_missing: issue spec');
  return {
    woId,
    specSource: `github:${input.repository}:issues/${String(input.issueNumber)}`,
    specRevision: `issue:${String(input.issueNumber)}:${updatedAt}`,
    specBytes: Buffer.from(body, 'utf8'),
  };
}

export async function freezeWorkOrderSource(
  policy: RunAuthorityPolicy,
  userMessage: string,
  dependencies: WorkOrderSourceDependencies = {}
): Promise<FrozenSpecSource> {
  const expected = readExpectedSpecIdentity(userMessage);
  const source = await resolveWorkOrderSource(policy, userMessage, dependencies);
  if (
    expected &&
    (source.specSource !== expected.specSource ||
      source.specRevision !== expected.specRevision ||
      `sha256:${createHash('sha256').update(source.specBytes).digest('hex')}` !== expected.specHash)
  )
    throw new Error('authority_conflict: canonical spec changed since eligibility');

  // AFTER the expected-spec comparison (the appended line must never alter that
  // hash): if a trusted repair-attempt row authorizes it, append the repair
  // target line to the canonical bytes and mark the revision.
  const repair = await resolveRepairTarget(userMessage, source.woId, dependencies);
  if (repair) {
    const specBytes = Buffer.concat([
      Buffer.from(source.specBytes),
      Buffer.from(`\n\nRepair target: PR #${repair.prNumber} (branch ${repair.headRef})\n`, 'utf8'),
    ]);
    return {
      ...source,
      repairAttemptId: repair.id,
      specBytes,
      specRevision: `${source.specRevision}+repair:${repair.id.slice(0, 8)}`,
    };
  }
  return source;
}

async function resolveWorkOrderSource(
  policy: RunAuthorityPolicy,
  userMessage: string,
  dependencies: WorkOrderSourceDependencies
): Promise<FrozenSpecSource> {
  const repository = policy.spec_repository;
  const woId = readWoId(userMessage);
  const issueNumber = readIssueNumber(userMessage);
  if (!woId) {
    if (!policy.allow_issue_fallback || !issueNumber) {
      throw new Error(
        policy.allow_issue_fallback
          ? 'scope_authority_missing: woId or issue'
          : 'scope_authority_missing: woId'
      );
    }
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const token = dependencies.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!dependencies.fetcher && !token) {
    throw new Error('scope_authority_missing: GitHub authentication');
  }
  const headers = githubHeaders(token);
  if (!woId && issueNumber) {
    return freezeIssueSource({ repository, issueNumber, fetcher, headers });
  }
  if (!woId) throw new Error('scope_authority_missing: woId');

  const revisionResponse = await fetcher(
    `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(policy.spec_revision)}`,
    { headers }
  );
  const revisionJson = await readJson(revisionResponse);
  const object = revisionJson.object;
  const specRevision =
    typeof object === 'object' &&
    object !== null &&
    typeof (object as { sha?: unknown }).sha === 'string'
      ? (object as { sha: string }).sha
      : '';

  if (specRevision) {
    for (const template of policy.spec_paths) {
      const path = template.replaceAll('{WO_ID}', woId);
      const response = await fetcher(
        `https://api.github.com/repos/${repository}/contents/${encodePath(path)}?ref=${encodeURIComponent(specRevision)}`,
        { headers }
      );
      const json = await readJson(response);
      if (json.type !== 'file' || typeof json.content !== 'string') continue;
      const specBytes = Buffer.from(json.content.replace(/\s/g, ''), 'base64');
      if (specBytes.byteLength === 0) continue;
      return {
        woId,
        specSource: `github:${repository}:${path}`,
        specRevision,
        specBytes,
      };
    }
  }

  if (policy.allow_issue_fallback && issueNumber) {
    return freezeIssueSource({ repository, issueNumber, messageWoId: woId, fetcher, headers });
  }
  if (!specRevision) throw new Error('scope_authority_missing: specRevision');
  throw new Error('scope_authority_missing: canonical spec');
}
