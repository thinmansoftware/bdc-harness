/**
 * Re-enqueue ONE Overseer review for one exact head of a pull request whose newest review row at
 * that head FAILED (WO-HARNESS-OVERSEER-REREVIEW-FAILED-HEAD-COMMAND-01, bdc-xo#5564).
 *
 * Why it exists: the push, reopen and reconcile paths all key one review row per head
 * (`pr-review:<owner>/<repo>#<n>@<head>`), and a failed row holds that key, so once the cause of a
 * failure is fixed nothing starts a new review of the same head. This command resends the failed
 * row's exact message body under a DISTINCT idempotency key and a recorded reason. It reads and
 * writes only Dispatch (never GitHub), refuses anything that is not a failed newest row, and never
 * touches the pull request.
 *
 * Run inside the container (documented in docs/operations/overseer-re-review.md):
 *   docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts <owner/repo> <pr> <head-sha> <reason words...> [--dry-run]
 *   docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts --show <owner/repo> <pr> [head-sha]
 *
 * Exit 0: re-enqueued (or dry run, or --show). Exit 2: refused or bad usage (one plain line says
 * why). Exit 1: Dispatch unreachable or rejected the message.
 *
 * Sender: the message is sent as `operator` through the same HTTP route a hand-enqueue uses
 * (POST /api/dispatch/messages). With DISPATCH_SENDER_AUTH_MODE unset the route takes the requested
 * sender as a legacy sender with no principal. This script never claims the system sender
 * `overseer`; if the route refuses `operator`, it says so and stops.
 */

export const REVIEW_RECIPIENT = 'overseer-reviewer';
export const OPERATOR_SENDER = 'operator';
export const REREVIEW_REASON_PREFIX = 'operator_request:rereview_failed:';
const HEX40 = /^[a-f0-9]{40}$/i;

export interface ReviewRow {
  id: string;
  status: string;
  body: string;
  created_at: string;
  seq?: number | null;
  task_type?: string;
  claimed_at?: string | null;
  completed_at?: string | null;
  result_body?: string | null;
  sender?: string;
  repeat_reason?: string | null;
}

export interface OutgoingMessage {
  sender: string;
  correlation_id: string;
  idempotency_key: string;
  task_type: 'run_review';
  recipient: string;
  body: string;
  subject_key: string;
  repeat_reason: string;
}

export interface DispatchPort {
  /** Every review row of the subject, any order. */
  list(subjectKey: string): Promise<ReviewRow[]>;
  /** Every FAILED review row of every pull request (the rebuild-edge sweep). */
  listFailed?(): Promise<ReviewRow[]>;
  send(message: OutgoingMessage): Promise<{ id: string; status: string }>;
}

export interface ReEnqueueInput {
  repository: string;
  prNumber: number;
  head: string;
  reason: string;
}

export type Decision =
  | { ok: false; refusal: string }
  | { ok: true; prior: ReviewRow; rowsAtHead: number; message: OutgoingMessage };

export function subjectKeyOf(repository: string, prNumber: number): string {
  return `gh:${repository.toLowerCase()}#${prNumber}`;
}

function headOf(row: ReviewRow): string | undefined {
  try {
    const parsed = JSON.parse(row.body) as { headSha?: unknown };
    return typeof parsed.headSha === 'string' ? parsed.headSha.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function order(a: ReviewRow, b: ReviewRow): number {
  if (typeof a.seq === 'number' && typeof b.seq === 'number' && a.seq !== b.seq)
    return a.seq - b.seq;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pure decision: refuse with one plain line, or build the exact message to send. */
export function decide(rows: ReviewRow[], input: ReEnqueueInput): Decision {
  const head = input.head.toLowerCase();
  if (!HEX40.test(head))
    return { ok: false, refusal: 'the head must be a full 40-character hex sha' };
  // eslint-disable-next-line no-control-regex
  const reason = input.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (reason.length < 10)
    return { ok: false, refusal: 'the reason must be at least 10 characters' };
  const reviews = rows.filter(row => row.task_type === undefined || row.task_type === 'run_review');
  const atHead = reviews.filter(row => headOf(row) === head).sort(order);
  if (atHead.length === 0)
    return {
      ok: false,
      refusal: `no review row at this head (${reviews.length} rows on this pull request, all at other heads)`,
    };
  const pending = atHead.find(row => row.status === 'queued' || row.status === 'claimed');
  if (pending)
    return {
      ok: false,
      refusal: `a review is already pending at this head: row ${pending.id} is ${pending.status}`,
    };
  // A CANCELLED row is never the verdict of a review: when a claim wins, Dispatch cancels the other
  // deliveries of the same head as `superseded_by_claim`, and those can be CREATED after the row that
  // failed (PR 101, 2026-11-12: row 97be1431 failed, then six duplicate deliveries were cancelled).
  // Judging the newest row by position made that failure look "cancelled, not failed" and the command
  // refused. Judge the newest row that is not cancelled.
  const decisive = atHead.filter(row => row.status !== 'cancelled');
  const newest = decisive[decisive.length - 1];
  if (newest === undefined)
    return {
      ok: false,
      refusal: `every review row at this head is cancelled (latest row ${atHead[atHead.length - 1].id}); nothing failed to re-run, use the push, recheck or reconcile path`,
    };
  if (newest.status !== 'failed')
    return {
      ok: false,
      refusal: `the newest row at this head is ${newest.status}, not failed (row ${newest.id}); use the push, recheck or reconcile path`,
    };
  const key = `${input.repository}#${input.prNumber}@${head}`;
  return {
    ok: true,
    prior: newest,
    rowsAtHead: atHead.length,
    message: {
      sender: OPERATOR_SENDER,
      correlation_id: `pr-review:${key}`,
      // One distinct key per state: k counts the rows already at this head, so a second run from
      // the same state computes the same key and Dispatch returns the row instead of inserting.
      idempotency_key: `pr-rereview:${key}:${atHead.length + 1}`,
      task_type: 'run_review',
      recipient: REVIEW_RECIPIENT,
      body: newest.body,
      subject_key: subjectKeyOf(input.repository, input.prNumber),
      repeat_reason: `${REREVIEW_REASON_PREFIX}${head} ${reason}`,
    },
  };
}

export function describeRow(row: ReviewRow): string {
  let result = '';
  try {
    const parsed = JSON.parse(row.result_body ?? '') as { disposition?: string; reason?: string };
    result = [parsed.disposition, parsed.reason].filter(Boolean).join('/');
  } catch {
    result = '';
  }
  return `row ${row.id.slice(0, 8)} ${row.status} created ${row.created_at} claimed ${row.claimed_at ?? '-'} done ${row.completed_at ?? '-'}${result ? ` ${result}` : ''}`;
}

export async function reEnqueue(
  port: DispatchPort,
  input: ReEnqueueInput,
  options: { dryRun?: boolean } = {}
): Promise<{ code: 0 | 1 | 2; lines: string[] }> {
  const subject = subjectKeyOf(input.repository, input.prNumber);
  let rows: ReviewRow[];
  try {
    rows = await port.list(subject);
  } catch (error) {
    return { code: 1, lines: [`could not read Dispatch: ${errorText(error)}`] };
  }
  const decision = decide(rows, input);
  if (!decision.ok) return { code: 2, lines: [`REFUSED ${decision.refusal}`] };
  const { message, prior } = decision;
  if (options.dryRun)
    return {
      code: 0,
      lines: [
        `DRY RUN would send run_review to ${message.recipient} as ${message.sender}`,
        `subject ${message.subject_key} key ${message.idempotency_key}`,
        `repeat_reason ${message.repeat_reason}`,
        `prior ${describeRow(prior)}`,
      ],
    };
  let sent: { id: string; status: string };
  try {
    sent = await port.send(message);
  } catch (error) {
    // A concurrent run may have won: if a row is now pending at this head, report it, do not fail.
    try {
      const again = decide(await port.list(subject), input);
      if (!again.ok && again.refusal.includes('already pending'))
        return { code: 0, lines: [`ALREADY_PENDING ${again.refusal}`] };
    } catch {
      /* report the original error below */
    }
    return { code: 1, lines: [`Dispatch rejected the message: ${errorText(error)}`] };
  }
  return {
    code: 0,
    lines: [
      `REENQUEUED row=${sent.id} head=${input.head.toLowerCase()} prior=${prior.id}:failed sender=${message.sender}`,
      `read it: docker exec archon-app-1 bun run /app/scripts/overseer/re-enqueue-review.ts --show ${input.repository} ${input.prNumber} ${input.head.toLowerCase()}`,
    ],
  };
}

/** Safety bound for the failed-row listing (500 rows a page); reaching it is an error, not a truncation. */
const LIST_FAILED_MAX_PAGES = 2000;

/** The reason the sweep sends with every row it re-enqueues. */
export const EDGE_SWEEP_REASON = 'failed at the rebuild edge';

/** A transport-level failure reason (not a verdict): the service was briefly unavailable. */
const TRANSPORT_FAILURE =
  /submission_failed|Service Unavailable|rate_limited|head_recheck_failed|ECONNRESET|ETIMEDOUT/i;

export interface EdgeSweepWindow {
  /** ISO time the rebuild started draining. */
  since: string;
  /** ISO time the new container started (plus any slack the caller wants). */
  until: string;
}

function edgeTarget(
  row: ReviewRow
): { repository: string; prNumber: number; head: string } | undefined {
  try {
    const parsed = JSON.parse(row.body) as {
      owner?: unknown;
      repo?: unknown;
      prNumber?: unknown;
      headSha?: unknown;
    };
    if (
      typeof parsed.owner === 'string' &&
      typeof parsed.repo === 'string' &&
      typeof parsed.prNumber === 'number' &&
      typeof parsed.headSha === 'string'
    )
      return {
        repository: `${parsed.owner}/${parsed.repo}`,
        prNumber: parsed.prNumber,
        head: parsed.headSha.toLowerCase(),
      };
  } catch {
    /* an unreadable body is not a candidate */
  }
  return undefined;
}

/**
 * After a rebuild: re-enqueue, once, every head whose review FAILED between the start of the drain and
 * the start of the new container with a transport reason (submission_failed, Service Unavailable,
 * rate_limited ...). The failure is the restart's, not the pull request's (PR 101, 2026-11-12: a review
 * claimed during the drain failed with "Service Unavailable" 40 seconds before the restart and nothing
 * else would ever have reviewed that head). Each head goes through the same decision as a hand
 * re-enqueue, so a head that already has a newer review, or pending work, is refused and left alone.
 */
export async function edgeSweep(
  port: DispatchPort,
  window: EdgeSweepWindow,
  options: { dryRun: boolean }
): Promise<{ code: number; lines: string[] }> {
  const since = Date.parse(window.since);
  const until = Date.parse(window.until);
  if (Number.isNaN(since) || Number.isNaN(until) || until < since)
    return { code: 2, lines: ['REFUSED the window must be two ISO times, since <= until'] };
  if (!port.listFailed)
    return { code: 1, lines: ['could not read Dispatch: no failed-row listing'] };
  let failed: ReviewRow[];
  try {
    failed = await port.listFailed();
  } catch (error) {
    return { code: 1, lines: [`could not read Dispatch: ${errorText(error)}`] };
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  let candidates = 0;
  let reenqueued = 0;
  let refused = 0;
  let errors = 0;
  for (const row of failed) {
    if (row.task_type !== undefined && row.task_type !== 'run_review') continue;
    const done = Date.parse(row.completed_at ?? '');
    if (Number.isNaN(done) || done < since || done > until) continue;
    if (!TRANSPORT_FAILURE.test(row.result_body ?? '')) continue;
    const target = edgeTarget(row);
    if (!target) continue;
    const key = `${target.repository}#${target.prNumber}@${target.head}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates += 1;
    const result = await reEnqueue(
      port,
      { ...target, reason: EDGE_SWEEP_REASON },
      { dryRun: options.dryRun }
    );
    if (result.code === 0 && result.lines.some(line => line.startsWith('REENQUEUED')))
      reenqueued += 1;
    else if (result.code === 2) refused += 1;
    else if (result.code !== 0) errors += 1;
    lines.push(`${key} ${result.lines[0] ?? ''}`);
  }
  lines.push(
    `EDGE_SWEEP window=${window.since}..${window.until} candidates=${candidates} reenqueued=${reenqueued} refused=${refused} errors=${errors}${options.dryRun ? ' (dry run)' : ''}`
  );
  return { code: errors > 0 ? 1 : 0, lines };
}

export async function show(
  port: DispatchPort,
  repository: string,
  prNumber: number,
  head?: string
): Promise<string[]> {
  const rows = (await port.list(subjectKeyOf(repository, prNumber)))
    .filter(row => row.task_type === undefined || row.task_type === 'run_review')
    .filter(row => head === undefined || headOf(row) === head.toLowerCase())
    .sort(order);
  return rows.length === 0
    ? ['no review rows']
    : rows.map(row => `${(headOf(row) ?? '?').slice(0, 9)} ${describeRow(row)}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The production port: the container's own Dispatch HTTP route, with the operator token header. */
export function createHttpPort(
  baseUrl: string = process.env.ARCHON_API_URL ?? `http://localhost:${process.env.PORT ?? '3090'}`,
  token: string | undefined = process.env.ARCHON_OPERATOR_TOKEN,
  doFetch: typeof fetch = fetch
): DispatchPort {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-archon-operator-token'] = token;
  return {
    async list(subjectKey): Promise<ReviewRow[]> {
      const url = `${baseUrl}/api/dispatch/messages?recipient=${REVIEW_RECIPIENT}&subject_key=${encodeURIComponent(subjectKey)}&limit=500`;
      const response = await doFetch(url, { headers });
      if (!response.ok) throw new Error(`list returned HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('list did not return an array');
      return data as ReviewRow[];
    },
    async listFailed(): Promise<ReviewRow[]> {
      // The cursor form of the list route: pages of failed rows, oldest first.
      const rows: ReviewRow[] = [];
      let afterSeq = 0;
      // Read EVERY page: a silent cap would drop the newest failures (the oldest come first) while the
      // sweep reported success (Overseer review of PR 1584). The cursor must advance on every full page,
      // and a runaway history is an error, never a quiet truncation.
      for (let page = 0; ; page += 1) {
        if (page >= LIST_FAILED_MAX_PAGES)
          throw new Error(
            `the failed-row history exceeds ${LIST_FAILED_MAX_PAGES} pages; not read in full`
          );
        const url = `${baseUrl}/api/dispatch/messages?recipient=${REVIEW_RECIPIENT}&after_seq=${afterSeq}&status=failed&limit=500`;
        const response = await doFetch(url, { headers });
        if (!response.ok) throw new Error(`list returned HTTP ${response.status}`);
        const data = (await response.json()) as {
          messages?: ReviewRow[];
          next_after_seq?: number;
          page_full?: boolean;
        };
        if (!Array.isArray(data.messages)) throw new Error('list did not return a page');
        rows.push(...data.messages);
        if (!data.page_full) break;
        if (typeof data.next_after_seq !== 'number' || data.next_after_seq <= afterSeq)
          throw new Error('the list cursor did not advance on a full page; not read in full');
        afterSeq = data.next_after_seq;
      }
      return rows;
    },
    async send(message): Promise<{ id: string; status: string }> {
      const response = await doFetch(`${baseUrl}/api/dispatch/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      });
      if (response.status === 401 || response.status === 403)
        throw new Error(
          `the route refused the sender ${message.sender} (HTTP ${response.status}); this command does not use the system sender, so stop and ask the acting XO`
        );
      if (!response.ok) throw new Error(`send returned HTTP ${response.status}`);
      const data = (await response.json()) as { id?: string; status?: string };
      if (!data.id) throw new Error('send returned no row id');
      return { id: data.id, status: data.status ?? 'queued' };
    },
  };
}

function usage(): never {
  console.error(
    'usage: re-enqueue-review.ts <owner/repo> <pr-number> <head-sha> <reason words...> [--dry-run]\n' +
      '       re-enqueue-review.ts --show <owner/repo> <pr-number> [head-sha]\n' +
      '       re-enqueue-review.ts --edge-sweep <since-iso> <until-iso> [--dry-run]'
  );
  process.exit(2);
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.filter(arg => arg !== '--dry-run');
  const dryRun = args.length !== argv.length;
  const port = createHttpPort();
  if (args[0] === '--show') {
    const [, repository, pr, head] = args;
    if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository) || !/^\d+$/.test(pr ?? '')) usage();
    try {
      for (const line of await show(port, repository, Number(pr), head)) console.log(line);
      return 0;
    } catch (error) {
      console.error(`could not read Dispatch: ${errorText(error)}`);
      return 1;
    }
  }
  if (args[0] === '--edge-sweep') {
    const [, since, until] = args;
    if (!since || !until) usage();
    const swept = await edgeSweep(port, { since, until }, { dryRun });
    for (const line of swept.lines) (swept.code === 0 ? console.log : console.error)(line);
    return swept.code;
  }
  const [repository, pr, head, ...reason] = args;
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository) || !/^\d+$/.test(pr ?? '') || !head)
    usage();
  const result = await reEnqueue(
    port,
    { repository, prNumber: Number(pr), head, reason: reason.join(' ') },
    { dryRun }
  );
  for (const line of result.lines) (result.code === 0 ? console.log : console.error)(line);
  return result.code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
