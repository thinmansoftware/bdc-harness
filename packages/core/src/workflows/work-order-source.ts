import { createHash } from 'crypto';
import { getMessage, type DispatchMessage } from '../db/dispatch';
import type { RunAuthorityPolicy } from '@archon/workflows/schemas/workflow';
import type { FrozenSpecSource } from '@archon/workflows/reliability/run-authority';

export interface WorkOrderSourceDependencies {
  readonly fetcher?: typeof fetch;
  readonly githubToken?: string;
  readonly loadReviewMessage?: (id: string) => Promise<DispatchMessage | null>;
}

export interface ReworkDirectiveRef {
  readonly prNumber: number;
  readonly branch: string;
  readonly headSha: string;
  readonly reviewMessageId: string;
}

export interface ReworkDirectiveReview {
  readonly summary: string;
}

/** A constraint on policy-resolved authority, never an alternate authority source. */
export interface ExpectedSpecIdentity {
  readonly specSource: string;
  readonly specRevision: string;
  readonly specHash: string;
}

const REWORK_REF_KEYS = ['prNumber', 'branch', 'headSha', 'reviewMessageId'] as const;

export function readReworkDirectiveRef(userMessage: string): ReworkDirectiveRef | undefined {
  const header = userMessage.split(/\r?\n/, 1)[0] ?? '';
  const match = /(?:^|\s)--rework=([A-Za-z0-9_-]*)/.exec(header);
  if (!match) return undefined;
  const token = match[1] ?? '';
  if (!token) throw new Error('authority_conflict: malformed rework directive');
  try {
    const value: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== REWORK_REF_KEYS.length ||
      REWORK_REF_KEYS.some(key => !keys.includes(key))
    ) {
      throw new Error();
    }
    const prNumber = record.prNumber;
    const branch = record.branch;
    const headSha = record.headSha;
    const reviewMessageId = record.reviewMessageId;
    if (
      typeof prNumber !== 'number' ||
      !Number.isInteger(prNumber) ||
      prNumber <= 0 ||
      typeof branch !== 'string' ||
      branch.length === 0 ||
      typeof headSha !== 'string' ||
      !/^[0-9a-fA-F]{40}$/.test(headSha) ||
      typeof reviewMessageId !== 'string' ||
      reviewMessageId.length === 0
    ) {
      throw new Error();
    }
    return { prNumber, branch, headSha, reviewMessageId };
  } catch {
    throw new Error('authority_conflict: malformed rework directive');
  }
}

export function renderReworkDirective(
  ref: ReworkDirectiveRef,
  review: ReworkDirectiveReview
): string {
  return [
    '',
    '## Rework directive (engine-appended, do not edit)',
    'REWORK_DIRECTIVE: overseer-changes-requested',
    `Repair target: PR #${ref.prNumber} (branch ${ref.branch})`,
    `Rework head: ${ref.headSha}`,
    `Review message: ${ref.reviewMessageId}`,
    'The Overseer rejected this exact head. Every finding below is an unmet requirement of this WO. Fix each one on this branch; do not open a new PR.',
    '### Overseer findings',
    review.summary,
  ].join('\n');
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
  const ref = readReworkDirectiveRef(userMessage);
  if (!ref) return source;
  const loadReviewMessage = dependencies.loadReviewMessage ?? getMessage;
  const row = await loadReviewMessage(ref.reviewMessageId);
  const summary = verifiedReworkSummary(row, ref);
  const directive = Buffer.from(renderReworkDirective(ref, { summary }), 'utf8');
  const canonical = source.specBytes;
  const separator =
    canonical.byteLength > 0 && canonical[canonical.byteLength - 1] === 0x0a
      ? Buffer.alloc(0)
      : Buffer.from('\n');
  return {
    ...source,
    specBytes: Buffer.concat([canonical, separator, directive]),
  };
}

function verifiedReworkSummary(row: DispatchMessage | null, ref: ReworkDirectiveRef): string {
  if (!row) throw new Error('authority_conflict: rework directive');
  if (row.task_type !== 'run_review' || row.recipient !== 'overseer-reviewer') {
    throw new Error('authority_conflict: rework directive');
  }
  const subject = row.subject_key ?? '';
  if (!subject.endsWith(`#${ref.prNumber}`)) {
    throw new Error('authority_conflict: rework directive');
  }
  let body: Record<string, unknown>;
  let result: Record<string, unknown>;
  try {
    const parsedBody: unknown = JSON.parse(row.body);
    const parsedResult: unknown = JSON.parse(row.result_body ?? '');
    if (
      typeof parsedBody !== 'object' ||
      parsedBody === null ||
      typeof parsedResult !== 'object' ||
      parsedResult === null
    ) {
      throw new Error();
    }
    body = parsedBody as Record<string, unknown>;
    result = parsedResult as Record<string, unknown>;
  } catch {
    throw new Error('authority_conflict: rework directive');
  }
  if (body.headSha !== ref.headSha || result.disposition !== 'changes_requested') {
    throw new Error('authority_conflict: rework directive');
  }
  if (typeof result.summary !== 'string') throw new Error('authority_conflict: rework directive');
  return result.summary;
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
