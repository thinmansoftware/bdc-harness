import { listOwnerLabels } from '@archon/core/github/owner-label';
import { createLogger } from '@archon/paths';

const log = createLogger('overseer/owner-resolution');

const BDC_OWNER = 'thinmansoftware';
const BDC_XO_REPO = 'bdc-xo';
const BDC_XO_REF = 'main';
const MOTIONS_PATH = 'docs/board/motions';

export type BoardSeat = 'Claude' | 'Codex' | 'Grok';

interface GitHubContentFile {
  type: 'file';
  name: string;
  path: string;
  content?: string;
  encoding?: string;
}

interface GitHubContentDirectoryEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
}

export interface OwnerResolutionOctokitLike {
  repos: {
    getContent(input: { owner: string; repo: string; path: string; ref: string }): Promise<{
      data: GitHubContentFile | GitHubContentDirectoryEntry[];
    }>;
  };
}

let octokit: Promise<OwnerResolutionOctokitLike & WorkOwnerOctokitLike> | null = null;

async function getOctokit(): Promise<OwnerResolutionOctokitLike & WorkOwnerOctokitLike> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  octokit ??= import('@octokit/rest').then(
    module =>
      new module.Octokit({ auth: token }) as unknown as OwnerResolutionOctokitLike &
        WorkOwnerOctokitLike
  );
  return octokit;
}

function decodeFile(data: GitHubContentFile | GitHubContentDirectoryEntry[]): string | null {
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return null;
  if (data.encoding !== 'base64') return null;
  return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

function seatFromText(value: string): BoardSeat | null {
  const seats = new Set<BoardSeat>();
  if (/\b(?:claude|opus|fable|acting xo)\b/i.test(value)) seats.add('Claude');
  if (/\b(?:gpt|codex|sol)\b/i.test(value)) seats.add('Codex');
  if (/\bgrok\b/i.test(value)) seats.add('Grok');
  return seats.size === 1 ? ([...seats][0] ?? null) : null;
}

const PROPOSER_LINE_RE = /^\*{0,2}(?:Proposed by|Mover):\*{0,2}(.*)$/i;
const APPROVAL_HEADING_PREFIX_RE = /^#{2,4}\s/;
const APPROVE_MARKER = ' -- approve';

function extractProposer(motion: string): string | null {
  for (const raw of motion.split('\n')) {
    const match = PROPOSER_LINE_RE.exec(raw.trim());
    if (!match) continue;
    const value = (match[1] ?? '').trim();
    if (value.length > 0) return value;
  }
  return null;
}

function approvalHeadingText(line: string): string | null {
  if (!APPROVAL_HEADING_PREFIX_RE.test(line)) return null;
  const collapsed = line.trim().replace(/\s+/g, ' ');
  const lower = collapsed.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < lower.length) {
    const index = lower.indexOf(APPROVE_MARKER, searchFrom);
    if (index === -1) return null;
    const next = collapsed.charAt(index + APPROVE_MARKER.length);
    if (next === '' || /\s/.test(next)) {
      const prefix = APPROVAL_HEADING_PREFIX_RE.exec(collapsed);
      if (!prefix) return null;
      const heading = collapsed.slice(prefix[0].length, index).trim();
      return heading.length > 0 ? heading : null;
    }
    searchFrom = index + 1;
  }
  return null;
}

export function extractBoardSeat(motion: string): BoardSeat | null {
  const proposer = extractProposer(motion);
  const proposedSeat = proposer ? seatFromText(proposer) : null;
  if (proposedSeat) return proposedSeat;

  const approvingSeats = new Set<BoardSeat>();
  for (const raw of motion.split('\n')) {
    const heading = approvalHeadingText(raw);
    if (!heading) continue;
    const seat = seatFromText(heading);
    if (seat) approvingSeats.add(seat);
  }
  return approvingSeats.size === 1 ? ([...approvingSeats][0] ?? null) : null;
}

function motionFilenameMatches(name: string, motionId: string): boolean {
  const suffix = motionId.replace(/^M-/i, '');
  if (!suffix) return false;
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^M-\\d{8}-${escaped}(?:-|\\.md$)`, 'i').test(name);
}

export async function resolveWoBoardSeatOwner(
  woId: string,
  client?: OwnerResolutionOctokitLike
): Promise<BoardSeat | null> {
  try {
    const github = client ?? (await getOctokit());
    const woResponse = await github.repos.getContent({
      owner: BDC_OWNER,
      repo: BDC_XO_REPO,
      path: `docs/work-orders/${woId}.md`,
      ref: BDC_XO_REF,
    });
    const woSpec = decodeFile(woResponse.data);
    if (!woSpec) return null;

    const motionId = /^\s*Parent motion:\s*(M-\S+)/im.exec(woSpec)?.[1];
    if (!motionId) return null;

    const directoryResponse = await github.repos.getContent({
      owner: BDC_OWNER,
      repo: BDC_XO_REPO,
      path: MOTIONS_PATH,
      ref: BDC_XO_REF,
    });
    if (!Array.isArray(directoryResponse.data)) return null;
    const matches = directoryResponse.data.filter(
      entry => entry.type === 'file' && motionFilenameMatches(entry.name, motionId)
    );
    if (matches.length !== 1 || !matches[0]) return null;

    const motionResponse = await github.repos.getContent({
      owner: BDC_OWNER,
      repo: BDC_XO_REPO,
      path: matches[0].path,
      ref: BDC_XO_REF,
    });
    const motion = decodeFile(motionResponse.data);
    return motion ? extractBoardSeat(motion) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WO-HARNESS-OVERSEER-OWNER-ROUTING-01: work-owner resolution.
//
// resolveWoBoardSeatOwner above answers "which board seat proposed the parent
// motion"; that is NOT ownership under M-93 and is not used for routing. The
// resolver below answers "who owns this work": the single owner:<handle> label
// on the WO's bdc-xo issue, backed by an assignment-provenance comment
// (M-93 clause 5). It never defaults to an XO principal (M-93 clause 2).
// Contract and operator steps: docs/operations/overseer-owner-routing.md.
// ---------------------------------------------------------------------------

/** OVERSEER_OWNER_ROUTING: exactly 'shadow' or 'on'; anything else is 'off'. */
export type OwnerRoutingMode = 'off' | 'shadow' | 'on';

export function readOwnerRoutingMode(
  raw: string | undefined = process.env.OVERSEER_OWNER_ROUTING
): OwnerRoutingMode {
  return raw === 'shadow' || raw === 'on' ? raw : 'off';
}

/** Upper bound on one resolveWorkOwner call; on expiry the result is lookup_failed. */
export const WORK_OWNER_LOOKUP_TIMEOUT_MS = 5_000;

const WORK_OWNER_ISSUE_REPO = `${BDC_OWNER}/${BDC_XO_REPO}`;
const COMMENT_PAGE_SIZE = 100;
const COMMENT_PAGE_LIMIT = 10;

export type WorkOwnerUnownedReason =
  | 'no_issue'
  | 'multiple_issues'
  | 'no_owner_label'
  | 'multiple_owner_labels'
  | 'owner_label_without_provenance'
  | 'lookup_failed';

export interface WorkOwnerOwned {
  kind: 'owned';
  owner: string;
  assigned_by: string;
  assigned_at: string;
  quote: string;
  /** `thinmansoftware/bdc-xo#<N>` */
  source_issue: string;
}

export interface WorkOwnerUnowned {
  kind: 'unowned';
  reason: WorkOwnerUnownedReason;
  /** `thinmansoftware/bdc-xo#<N>` when one WO issue was chosen, else null. */
  source_issue: string | null;
}

export type WorkOwnerResolution = WorkOwnerOwned | WorkOwnerUnowned;

export interface WorkOwnerLookupInput {
  woId: string;
  repository?: string | null;
  prNumber?: number | null;
}

export interface WorkOwnerSearchItem {
  number: number;
  title: string;
  state: string;
  labels?: (string | { name?: string | null })[];
  pull_request?: unknown;
}

export interface WorkOwnerComment {
  body?: string | null;
  created_at: string;
}

export interface WorkOwnerOctokitLike {
  search: {
    issuesAndPullRequests(input: {
      q: string;
      per_page?: number;
      request?: { signal?: AbortSignal };
    }): Promise<{ data: { items: WorkOwnerSearchItem[] } }>;
  };
  issues: {
    listComments(input: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page?: number;
      page?: number;
      request?: { signal?: AbortSignal };
    }): Promise<{ data: WorkOwnerComment[] }>;
  };
}

export interface ResolveWorkOwnerOptions {
  client?: WorkOwnerOctokitLike;
  timeoutMs?: number;
}

/** True when the issue title, split on [^A-Za-z0-9-], has a token exactly equal to woId. */
export function titleHasExactWoToken(title: string, woId: string): boolean {
  return title.split(/[^A-Za-z0-9-]+/).some(token => token === woId);
}

function labelNames(labels: WorkOwnerSearchItem['labels']): string[] {
  const names: string[] = [];
  for (const label of labels ?? []) {
    if (typeof label === 'string') names.push(label);
    else if (typeof label.name === 'string') names.push(label.name);
  }
  return names;
}

const ASSIGNED_AT_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)?$/;
const PROVENANCE_LINE_RE = /^\s*(Owner assigned|Assigned by|Assigned at|Quote):\s*(.*?)\s*$/i;

export interface ProvenanceRecord {
  handle: string;
  assigned_by: string;
  assigned_at: string;
  quote: string;
}

/**
 * Parse one assignment-provenance comment. All four lines are required, each
 * on its own line: `Owner assigned: <handle>`, `Assigned by: <name>`,
 * `Assigned at: <YYYY-MM-DD or ISO-8601 UTC>`, `Quote: <verbatim text>`.
 * A comment missing any line, or with an unparseable date, does not count.
 */
export function parseProvenanceComment(body: string): ProvenanceRecord | null {
  const fields = new Map<string, string>();
  for (const raw of body.split(/\r?\n/)) {
    const match = PROVENANCE_LINE_RE.exec(raw);
    if (!match) continue;
    const key = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? '';
    if (value && !fields.has(key)) fields.set(key, value);
  }
  const handle = fields.get('owner assigned');
  const assignedBy = fields.get('assigned by');
  const assignedAt = fields.get('assigned at');
  const quote = fields.get('quote');
  if (!handle || !assignedBy || !assignedAt || !quote) return null;
  if (!ASSIGNED_AT_RE.test(assignedAt) || Number.isNaN(Date.parse(assignedAt))) return null;
  return { handle, assigned_by: assignedBy, assigned_at: assignedAt, quote };
}

async function listAllComments(
  github: WorkOwnerOctokitLike,
  issueNumber: number,
  signal: AbortSignal
): Promise<WorkOwnerComment[]> {
  const comments: WorkOwnerComment[] = [];
  for (let page = 1; page <= COMMENT_PAGE_LIMIT; page += 1) {
    const response = await github.issues.listComments({
      owner: BDC_OWNER,
      repo: BDC_XO_REPO,
      issue_number: issueNumber,
      per_page: COMMENT_PAGE_SIZE,
      page,
      request: { signal },
    });
    comments.push(...response.data);
    if (response.data.length < COMMENT_PAGE_SIZE) return comments;
  }
  // More comments than the page limit: refuse rather than miss the newest record.
  throw new Error('work_owner_comment_page_limit');
}

async function lookupWorkOwner(
  github: WorkOwnerOctokitLike,
  woId: string,
  signal: AbortSignal
): Promise<WorkOwnerResolution> {
  const search = await github.search.issuesAndPullRequests({
    q: `repo:${WORK_OWNER_ISSUE_REPO} is:issue in:title "${woId}"`,
    per_page: 100,
    request: { signal },
  });
  const matching = search.data.items.filter(
    item => !item.pull_request && titleHasExactWoToken(item.title, woId)
  );
  const open = matching.filter(item => item.state === 'open');
  // Open issues win over closed ones; more than one candidate is ambiguous
  // and fails closed rather than guessing.
  const pool = open.length > 0 ? open : matching;
  const issue = pool[0];
  if (!issue) return { kind: 'unowned', reason: 'no_issue', source_issue: null };
  if (pool.length > 1) return { kind: 'unowned', reason: 'multiple_issues', source_issue: null };
  const sourceIssue = `${WORK_OWNER_ISSUE_REPO}#${issue.number}`;

  const owners = listOwnerLabels(labelNames(issue.labels));
  const owner = owners[0];
  if (!owner) return { kind: 'unowned', reason: 'no_owner_label', source_issue: sourceIssue };
  if (owners.length > 1) {
    return { kind: 'unowned', reason: 'multiple_owner_labels', source_issue: sourceIssue };
  }

  let newest: { record: ProvenanceRecord; createdAt: number } | null = null;
  for (const comment of await listAllComments(github, issue.number, signal)) {
    const record = parseProvenanceComment(comment.body ?? '');
    if (record?.handle.toLowerCase() !== owner.toLowerCase()) continue;
    const createdAt = Date.parse(comment.created_at);
    if (Number.isNaN(createdAt)) continue;
    if (!newest || createdAt >= newest.createdAt) newest = { record, createdAt };
  }
  if (!newest) {
    return {
      kind: 'unowned',
      reason: 'owner_label_without_provenance',
      source_issue: sourceIssue,
    };
  }
  return {
    kind: 'owned',
    owner,
    assigned_by: newest.record.assigned_by,
    assigned_at: newest.record.assigned_at,
    quote: newest.record.quote,
    source_issue: sourceIssue,
  };
}

/**
 * Resolve the recorded owner of a WO's work. Never throws: any GitHub error,
 * a malformed response, or the WORK_OWNER_LOOKUP_TIMEOUT_MS bound expiring
 * returns unowned lookup_failed, so a slow GitHub never stalls card creation.
 * repository and prNumber are accepted as card context; the WO issue is
 * always looked up on thinmansoftware/bdc-xo.
 */
export async function resolveWorkOwner(
  input: WorkOwnerLookupInput,
  options: ResolveWorkOwnerOptions = {}
): Promise<WorkOwnerResolution> {
  const failed: WorkOwnerUnowned = { kind: 'unowned', reason: 'lookup_failed', source_issue: null };
  const woId = input.woId.trim();
  if (!woId) return failed;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WorkOwnerResolution>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      log.warn({ woId, reason: 'timeout' }, 'overseer.owner_routing.lookup_failed');
      resolve(failed);
    }, options.timeoutMs ?? WORK_OWNER_LOOKUP_TIMEOUT_MS);
  });
  const lookup = (async (): Promise<WorkOwnerResolution> => {
    try {
      const github = options.client ?? (await getOctokit());
      return await lookupWorkOwner(github, woId, controller.signal);
    } catch (error) {
      // Intentional fail-safe: an unresolved owner becomes the explicit
      // unowned bucket (never XO), and the error is logged, not swallowed.
      if (!controller.signal.aborted) {
        log.warn(
          { woId, error: (error as Error).message, errorType: (error as Error).name },
          'overseer.owner_routing.lookup_failed'
        );
      }
      return failed;
    }
  })();
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
