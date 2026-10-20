/**
 * lane-pr-registry.ts -- attribute a pull request to the lane run that built it.
 *
 * WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01.
 *
 * THE PROBLEM. A lane-built PR and a human PR carry the SAME author login
 * (bluedevilcollectibles), so author is not a usable "lane-created" signal. The
 * only durable proof that a lane opened a PR is the event store: a run's
 * implement / open-pr-if-needed node emits a node_completed / tool_completed
 * event whose data cites the PR url, and the run's user_message carries the
 * WO_ID. This module turns that proof into a structured, read-only query so the
 * PR repair owner (and the conductor's open-PR guard) can decide, mechanically,
 * whether a PR is lane-created for a given Work Order -- never touching a human
 * PR, an APPROVED PR a human is about to merge, or the author-wo.sh spec PR.
 *
 * THE LANE PR RULE (all four must hold for PR N to be lane-created for WO W):
 *   (a) an event row (event_type in node_completed/tool_completed; step_name in
 *       implement/open-pr-if-needed) whose data cites
 *       github.com/<owner>/<repo>/pull/<N> (not followed by a digit) belongs to
 *       a run R whose extractWoId(R.user_message) === W exactly;
 *   (b) the PR's GitHub created_at is within
 *       [R.started_at - 60s, (R.completed_at or now) + 60s];
 *   (c) the PR head is in the same repository (not a fork) AND its head ref
 *       matches ^(feat|fix|wip)/[A-Za-z0-9_-]+$ or
 *       ^archon/task-web-worker-[0-9]+-[A-Za-z0-9]+$ (refs starting wo/ are
 *       author-wo.sh spec branches and are NEVER lane-created);
 *   (d) textClaimsWoId on the PR title, body or head ref is true for W.
 *
 * The DB part is read-only SQL against remote_agent_workflow_runs and
 * remote_agent_workflow_events. The GitHub part (created_at, head, state,
 * reviewDecision, title, body) is an INJECTED fetcher, so tests run with no
 * network and no real GitHub reads.
 */
import { createLogger } from '@archon/paths';
import { getDatabase } from './connection';
import type { IDatabase } from './adapters/types';
import { extractWoId } from '../escalation/escalation-linker';

const log = createLogger('db/lane-pr-registry');

/**
 * A minimal read-only database surface -- the SELECTs this module needs. Reuses
 * IDatabase's own `query` type so tests and the live connection share one shape.
 */
export type LanePrRegistryDb = Pick<IDatabase, 'query'>;

export type LanePrState = 'OPEN' | 'CLOSED' | 'MERGED';

/** The GitHub facts about one PR the LANE PR RULE needs. Injected for tests. */
export interface LanePrGithubInfo {
  number: number;
  state: LanePrState;
  /** GitHub reviewDecision (APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null). */
  reviewDecision: string | null;
  /** PR creation instant (ISO-8601). */
  createdAt: string;
  headRefName: string;
  headSha: string;
  /** owner/repo of the head branch's repository; null when unknown. */
  headRepoFullName: string | null;
  /** owner/repo of the base repository (where the PR lives). */
  baseRepoFullName: string;
  title: string;
  body: string;
}

/**
 * Fetch the GitHub facts for one PR by number. Returns null when the PR cannot
 * be read (deleted, not found, or the fetcher has no such PR seeded).
 */
export type LanePrFetcher = (
  owner: string,
  repo: string,
  prNumber: number
) => Promise<LanePrGithubInfo | null>;

/** A PR proven lane-created for a WO. */
export interface LanePr {
  owner: string;
  repo: string;
  prNumber: number;
  headRef: string;
  headSha: string;
  state: LanePrState;
  reviewDecision: string | null;
  createdAt: string;
  /** The run id whose window and event attributed this PR. */
  runId: string;
  workflowName: string;
}

export interface ListLanePrsOptions {
  /** Injected GitHub fetcher -- required (no implicit network). */
  fetchPr: LanePrFetcher;
  /** Read-only DB handle; defaults to the live connection. */
  db?: LanePrRegistryDb;
  /** Clock seam; defaults to Date.now. */
  now?: () => number;
}

export interface ListWosWithMultipleLanePrsOptions extends ListLanePrsOptions {
  /** Only consider runs started within this many hours. Default 168 (7 days). */
  withinHours?: number;
}

export interface WoWithMultipleLanePrs {
  woId: string;
  prs: LanePr[];
}

/**
 * A WO+repository whose lane-PR lookup threw. Dedupe must not act on a partial
 * set for this group. `error` is the normalized message only; callers that must
 * rethrow keep the original thrown value separately.
 */
export interface UnresolvedLanePrGroup {
  woId: string;
  owner: string;
  repo: string;
  prNumber: number;
  error: string;
}

/** Dedupe-eligible groups plus the WO+repository lookups that failed closed. */
export interface ListWosWithMultipleLanePrsResult {
  groups: WoWithMultipleLanePrs[];
  unresolved: UnresolvedLanePrGroup[];
}

/** Internal resolution: public metadata plus the original thrown values. */
interface LanePrResolution {
  prs: LanePr[];
  unresolved: UnresolvedLanePrGroup[];
  /** Encounter order. listLanePrsForWo rethrows the first value unchanged. */
  thrown: unknown[];
}

const WINDOW_SLACK_MS = 60_000;

/** Event types + step names that prove a lane opened a PR. */
const LANE_EVENT_TYPES = ['node_completed', 'tool_completed'] as const;
const LANE_STEP_NAMES = ['implement', 'open-pr-if-needed'] as const;

/** feat/fix/wip or archon/task-web-worker heads are lane-created; wo/ never is. */
const LANE_HEAD_RE =
  /^(?:feat|fix|wip)\/[A-Za-z0-9_-]+$|^archon\/task-web-worker-[0-9]+-[A-Za-z0-9]+$/;

/**
 * Cite every github.com/<owner>/<repo>/pull/<N> reference in a blob of event
 * data. The negative lookahead keeps /pull/31700 from also yielding 3170 -- the
 * full digit run is always captured, so a longer number never produces a
 * spurious shorter one.
 */
const PR_URL_RE = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?!\d)/g;

/**
 * Markdown headings that mark the lines beneath them as explicitly OUT of scope
 * -- a WO id there is a disclaimer, not a completion claim. Mirrors
 * already-satisfied.ts (bdc-xo#1795); duplicated here because @archon/core must
 * not depend on @archon/smart-cauldron (that is the dependency direction).
 */
const EXCLUSION_HEADING_RE =
  /^\s{0,3}#{1,6}\s*(files?\s+)?(explicitly\s+)?(out\s+of\s+scope|not\s+in\s+scope|explicitly\s+excluded)\b/i;
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;

function stripExclusionSections(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let inExclusion = false;
  for (const line of lines) {
    if (EXCLUSION_HEADING_RE.test(line)) {
      inExclusion = true;
      continue;
    }
    if (inExclusion && ANY_HEADING_RE.test(line)) inExclusion = false;
    if (!inExclusion) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * True when text contains the exact WO_ID as a token, outside any "out of
 * scope" section. Case-insensitive; hyphen is a boundary so "-thread-abc"
 * suffixes are allowed but a longer sibling id ("WO-FOO-010" for "WO-FOO-01")
 * is not. Faithful reimplementation of already-satisfied.textClaimsWoId.
 */
export function textClaimsWoId(text: string, woId: string): boolean {
  if (!woId || !text) return false;
  const hay = stripExclusionSections(text).toLowerCase();
  const needle = woId.toLowerCase();
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : hay[idx - 1];
    const afterIdx = idx + needle.length;
    const after = afterIdx >= hay.length ? '' : hay[afterIdx];
    const beforeOk = idx === 0 || /[^a-z0-9]/.test(before);
    const afterOk = after === '' || /[^a-z0-9]/.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
}

interface LaneEventRow {
  run_id: string;
  user_message: string | null;
  workflow_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  data: unknown;
}

/** A PR citation plus the run that cited it (pre-GitHub, pre-rule). */
interface PrCitation {
  owner: string;
  repo: string;
  prNumber: number;
  runId: string;
  workflowName: string;
  /** The WO id extracted from the citing run's user_message (rule a). */
  woId: string;
  startedAtMs: number;
  completedAtMs: number | null;
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** WO plus the lowercased repository slug. Two WOs in one repo stay distinct. */
function laneGroupKey(woId: string, owner: string, repo: string): string {
  return `${woId}|${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  // SQLite stores UTC text as 'YYYY-MM-DD HH:MM:SS' (no zone). Treat as UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Collect PR citations from lane event rows, keeping only rows whose run's
 * extracted WO id equals the target exactly (rule a). One PR may be cited by
 * more than one run; every citation is kept here and resolved later by window.
 */
function collectCitations(rows: readonly LaneEventRow[], woId: string | null): PrCitation[] {
  const out: PrCitation[] = [];
  for (const row of rows) {
    const runWoId = extractWoId(row.user_message);
    if (!runWoId) continue;
    if (woId !== null && runWoId !== woId) continue;
    const startedAtMs = parseMs(row.started_at);
    if (startedAtMs === null) continue;
    const completedAtMs = parseMs(row.completed_at);
    const text = toText(row.data);
    PR_URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PR_URL_RE.exec(text)) !== null) {
      const owner = match[1];
      const repo = match[2];
      const prNumber = Number.parseInt(match[3], 10);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) continue;
      out.push({
        owner,
        repo,
        prNumber,
        runId: row.run_id,
        workflowName: row.workflow_name ?? '',
        woId: runWoId,
        startedAtMs,
        completedAtMs,
      });
    }
  }
  return out;
}

/**
 * Apply rules (b), (c), (d) against the fetched GitHub facts. Returns a LanePr
 * when all hold, else null. The run context (b/runId) is supplied by the
 * citation.
 */
function applyRuleBcd(
  citation: PrCitation,
  info: LanePrGithubInfo,
  woId: string,
  nowMs: number
): LanePr | null {
  // (b) created_at within the run window (+/- 60s slack).
  const createdMs = parseMs(info.createdAt);
  if (createdMs === null) return null;
  const windowStart = citation.startedAtMs - WINDOW_SLACK_MS;
  const windowEnd = (citation.completedAtMs ?? nowMs) + WINDOW_SLACK_MS;
  if (createdMs < windowStart || createdMs > windowEnd) return null;

  // (c) same-repo head (not a fork) + lane head-ref shape (wo/ excluded). The
  // LANE PR RULE requires POSITIVE proof the head lives in the base repository:
  // a null headRepoFullName (fork deleted, head repo unavailable) is not proof
  // and must be rejected, just like an explicit cross-repo mismatch. Compare
  // case-insensitively since GitHub repo slugs are case-insensitive.
  if (info.headRepoFullName?.toLowerCase() !== info.baseRepoFullName.toLowerCase()) {
    return null;
  }
  if (!LANE_HEAD_RE.test(info.headRefName)) return null;

  // (d) the PR claims the WO in its title, body, or head ref.
  if (
    !textClaimsWoId(info.title, woId) &&
    !textClaimsWoId(info.body, woId) &&
    !textClaimsWoId(info.headRefName, woId)
  ) {
    return null;
  }

  return {
    owner: citation.owner,
    repo: citation.repo,
    prNumber: citation.prNumber,
    headRef: info.headRefName,
    headSha: info.headSha,
    state: info.state,
    reviewDecision: info.reviewDecision,
    createdAt: info.createdAt,
    runId: citation.runId,
    workflowName: citation.workflowName,
  };
}

async function resolveLanePrs(
  citations: PrCitation[],
  woId: string,
  fetchPr: LanePrFetcher,
  nowMs: number
): Promise<LanePrResolution> {
  // Group citations by PR so each PR is fetched once; a PR cited by multiple
  // runs is attributed to the first run whose window contains its created_at.
  const byPr = new Map<string, PrCitation[]>();
  for (const citation of citations) {
    const key = `${citation.owner.toLowerCase()}/${citation.repo.toLowerCase()}#${citation.prNumber}`;
    const list = byPr.get(key);
    if (list) list.push(citation);
    else byPr.set(key, [citation]);
  }

  // A thrown lookup fails the whole WO+repository. Null is still "not a lane
  // PR" and does not poison the group. Siblings resolved before the throw are
  // dropped so callers never see a partial set.
  const resolvedByGroup = new Map<string, LanePr[]>();
  const failed = new Map<string, { citation: PrCitation; error: unknown }>();
  for (const group of byPr.values()) {
    const first = group[0];
    const groupKey = laneGroupKey(woId, first.owner, first.repo);
    if (failed.has(groupKey)) continue;
    let info: LanePrGithubInfo | null;
    try {
      info = await fetchPr(first.owner, first.repo, first.prNumber);
    } catch (error) {
      log.warn(
        {
          woId,
          owner: first.owner,
          repo: first.repo,
          prNumber: first.prNumber,
          error: errorMessage(error),
        },
        'lane_pr.lookup_failed'
      );
      failed.set(groupKey, { citation: first, error });
      resolvedByGroup.delete(groupKey);
      continue;
    }
    if (!info) continue;
    for (const citation of group) {
      const lane = applyRuleBcd(citation, info, woId, nowMs);
      if (lane) {
        const list = resolvedByGroup.get(groupKey) ?? [];
        list.push(lane);
        resolvedByGroup.set(groupKey, list);
        break;
      }
    }
  }

  const prs: LanePr[] = [];
  for (const [groupKey, lanes] of resolvedByGroup) {
    if (failed.has(groupKey)) continue;
    prs.push(...lanes);
  }
  const unresolved: UnresolvedLanePrGroup[] = [];
  const thrown: unknown[] = [];
  for (const failure of failed.values()) {
    unresolved.push({
      woId,
      owner: failure.citation.owner,
      repo: failure.citation.repo,
      prNumber: failure.citation.prNumber,
      error: errorMessage(failure.error),
    });
    thrown.push(failure.error);
  }
  return { prs, unresolved, thrown };
}

/**
 * Every PR provably lane-created for WO `woId`. Read-only; GitHub facts come
 * from the injected fetcher. Fail-closed: if any WO+repository lookup throws,
 * the original error is rethrown and no partial list is returned.
 */
export async function listLanePrsForWo(woId: string, opts: ListLanePrsOptions): Promise<LanePr[]> {
  if (!woId) return [];
  const db = opts.db ?? getDatabase();
  const nowMs = (opts.now ?? Date.now)();
  const eventTypes = LANE_EVENT_TYPES.map(t => `'${t}'`).join(', ');
  const stepNames = LANE_STEP_NAMES.map(s => `'${s}'`).join(', ');
  const result = await db.query<LaneEventRow>(
    `SELECT r.id AS run_id, r.user_message AS user_message, r.workflow_name AS workflow_name,
            r.started_at AS started_at, r.completed_at AS completed_at, e.data AS data
     FROM remote_agent_workflow_runs r
     JOIN remote_agent_workflow_events e ON e.workflow_run_id = r.id
     WHERE e.event_type IN (${eventTypes})
       AND e.step_name IN (${stepNames})
       AND r.user_message LIKE $1`,
    [`%${woId}%`]
  );
  const citations = collectCitations(result.rows, woId);
  const resolved = await resolveLanePrs(citations, woId, opts.fetchPr, nowMs);
  if (resolved.thrown.length > 0) {
    throw resolved.thrown[0];
  }
  return resolved.prs;
}

/**
 * Every WO that has 2 or more lane-created PRs in one repository within the
 * dedupe window, plus any WO+repository whose lookup threw. A failed group is
 * omitted from `groups` (no partial set). A healthy repository for the same WO
 * stays eligible on its own. One failed lookup does not reject the call.
 */
export async function listWosWithMultipleLanePrs(
  opts: ListWosWithMultipleLanePrsOptions
): Promise<ListWosWithMultipleLanePrsResult> {
  const db = opts.db ?? getDatabase();
  const nowMs = (opts.now ?? Date.now)();
  const withinHours = opts.withinHours ?? 168;
  const cutoffIso = new Date(nowMs - withinHours * 3_600_000).toISOString();
  const eventTypes = LANE_EVENT_TYPES.map(t => `'${t}'`).join(', ');
  const stepNames = LANE_STEP_NAMES.map(s => `'${s}'`).join(', ');
  const result = await db.query<LaneEventRow>(
    `SELECT r.id AS run_id, r.user_message AS user_message, r.workflow_name AS workflow_name,
            r.started_at AS started_at, r.completed_at AS completed_at, e.data AS data
     FROM remote_agent_workflow_runs r
     JOIN remote_agent_workflow_events e ON e.workflow_run_id = r.id
     WHERE e.event_type IN (${eventTypes})
       AND e.step_name IN (${stepNames})
       AND r.started_at >= $1`,
    [cutoffIso]
  );

  // Group citations by WO id first so each WO resolves its own PR set.
  const byWo = new Map<string, PrCitation[]>();
  for (const row of result.rows) {
    const runWoId = extractWoId(row.user_message);
    if (!runWoId) continue;
    const citations = collectCitations([row], runWoId);
    if (citations.length === 0) continue;
    const list = byWo.get(runWoId);
    if (list) list.push(...citations);
    else byWo.set(runWoId, citations);
  }

  const groups: WoWithMultipleLanePrs[] = [];
  const unresolved: UnresolvedLanePrGroup[] = [];
  for (const [woId, citations] of byWo) {
    const resolved = await resolveLanePrs(citations, woId, opts.fetchPr, nowMs);
    unresolved.push(...resolved.unresolved);
    const byRepo = new Map<string, LanePr[]>();
    for (const pr of resolved.prs) {
      const repoKey = `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}`;
      const list = byRepo.get(repoKey) ?? [];
      list.push(pr);
      byRepo.set(repoKey, list);
    }
    const eligible: LanePr[] = [];
    for (const prs of byRepo.values()) {
      if (prs.length >= 2) eligible.push(...prs);
    }
    if (eligible.length >= 2) groups.push({ woId, prs: eligible });
  }
  return { groups, unresolved };
}

/**
 * Resolve ONE PR to its lane attribution: the WO it was built for and the
 * LanePr facts, or null when the LANE PR RULE does not prove it. Used by the
 * Overseer submit path (resolveLaneRepairContext) to decide, with one targeted
 * event-store read plus one GitHub PR read, whether a reviewed PR is
 * lane-created -- the structural signal that authorizes an in-place repair.
 */
export async function attributeLanePr(
  input: { owner: string; repo: string; prNumber: number },
  opts: ListLanePrsOptions
): Promise<{ lane: LanePr; woId: string } | null> {
  const db = opts.db ?? getDatabase();
  const nowMs = (opts.now ?? Date.now)();
  const eventTypes = LANE_EVENT_TYPES.map(t => `'${t}'`).join(', ');
  const stepNames = LANE_STEP_NAMES.map(s => `'${s}'`).join(', ');
  const result = await db.query<LaneEventRow>(
    `SELECT r.id AS run_id, r.user_message AS user_message, r.workflow_name AS workflow_name,
            r.started_at AS started_at, r.completed_at AS completed_at, e.data AS data
     FROM remote_agent_workflow_runs r
     JOIN remote_agent_workflow_events e ON e.workflow_run_id = r.id
     WHERE e.event_type IN (${eventTypes})
       AND e.step_name IN (${stepNames})
       AND e.data LIKE $1`,
    [`%/pull/${input.prNumber}%`]
  );
  const citations = collectCitations(result.rows, null).filter(
    c =>
      c.owner.toLowerCase() === input.owner.toLowerCase() &&
      c.repo.toLowerCase() === input.repo.toLowerCase() &&
      c.prNumber === input.prNumber
  );
  if (citations.length === 0) return null;

  let info: LanePrGithubInfo | null;
  try {
    info = await opts.fetchPr(input.owner, input.repo, input.prNumber);
  } catch {
    info = null;
  }
  if (!info) return null;

  for (const citation of citations) {
    const lane = applyRuleBcd(citation, info, citation.woId, nowMs);
    if (lane) return { lane, woId: citation.woId };
  }
  return null;
}
