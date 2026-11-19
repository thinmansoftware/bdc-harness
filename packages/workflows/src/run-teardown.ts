/**
 * Identity-verified run teardown (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01).
 *
 * At run end, signal only processes this run can be shown to own, one pid at a
 * time, each re-verified immediately before the signal. A process is RUN-OWNED
 * for run R only when all hold, read from /proc at scan time:
 *   (a) its cwd resolves to R.working_path or a path inside it;
 *   (b) its start time is strictly after R.started_at;
 *   (c) its real uid equals this server's uid;
 *   (d) it is not this server, an ancestor of this server, or PID 1.
 * Nothing else is owned: not names, not process groups, not sessions, not
 * parentage. No process-group signal exists in this module.
 *
 * Every OBSERVABLE cwd holder inside the worktree blocks confirmation. The
 * start-time and uid predicates decide only which holders may be SIGNALED;
 * a holder that predates the run or belongs to another uid is never signaled
 * and is listed as a survivor (predates_run / foreign_uid). A same-uid entry
 * whose cwd or stat cannot be read (any error other than ENOENT/ESRCH) makes
 * the scan incomplete, never empty.
 *
 * Accepted limits (stated verbatim for exact-head reviewers):
 *   (1) a run-owned process that leaves the run's worktree (chdir elsewhere) is
 *       not detected; closing that needs cgroups and is out of scope;
 *   (2) a same-uid process started by someone else (an operator shell) after the
 *       run began, with its cwd inside the run's worktree, is treated as
 *       run-owned and terminated at run end;
 *   (3) only Linux proves teardown;
 *   (4) the window between the final re-read and `process.kill` is not closed: if
 *       the verified process exits and its pid is reused by a new same-uid process
 *       inside that window (microseconds; pid reuse needs the pid space to wrap),
 *       the new process could receive the signal. Closing it needs a pidfd-bound
 *       signal (pidfd_open plus pidfd_send_signal), which Bun does not expose; out
 *       of scope, accepted by John 2026-11-01 via XO after five review rounds.
 * Additional limit found on ubuntu CI: a same-uid process whose cwd is unreadable
 * (non-dumpable, e.g. after a credential change) and that started at or before
 * the start-time floor is not observable and does not block; one that started
 * after the floor makes the scan incomplete.
 *
 * Node-timeout teardown is node-specific: every bash/script node subprocess is
 * spawned with ARCHON_NODE_RUN_ID=<run>:<node> in its environment, inherited by all
 * of its descendants (it survives reparenting after the direct child is
 * killed). A timeout signals only processes whose /proc/<pid>/environ carries
 * that node's token, each still required to satisfy (a)-(d) against the node's
 * start time. A concurrent node's processes in the same worktree carry a
 * different token and are never touched. A same-uid holder whose environ cannot
 * be read makes the node scan incomplete.
 *
 * Upstream principle (MIT, attribution only): coleam00/Archon #3446 records a
 * run released only after its live owner is proven stopped. Grace/confirm
 * constants come from upstream run-owner-stop.ts. Upstream signals a process
 * group; this module deliberately does not.
 */
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'fs';
import { resolve, sep } from 'path';
import { createLogger } from '@archon/paths';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';
import { parseDbTimestamp } from './utils/duration';

export const TERMINATION_GRACE_MS = 5000;
export const TERMINATION_CONFIRM_MS = 1000;
export const TERMINATION_POLL_MS = 250;
export const TERMINAL_LEASE_MIN_AGE_MS = 600_000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'escalated', 'cancelled']);

const log = createLogger('workflow.run-teardown');

export type TeardownSurvivorReason =
  | 'predates_run'
  | 'foreign_uid'
  | 'scan_incomplete'
  | 'survived_kill'
  | 'teardown_unverifiable'
  | 'path_shared_with_active_run'
  | 'identity_changed';

export interface TeardownSurvivor {
  readonly pid?: number;
  readonly comm?: string;
  readonly reason: TeardownSurvivorReason;
}

export interface ProcStat {
  readonly state: string;
  readonly ppid: number;
  readonly startTicks: number;
  readonly comm: string;
}

/**
 * Narrow /proc reader. Methods throw NodeJS.ErrnoException-like errors; code
 * ENOENT or ESRCH means the process exited.
 */
export interface ProcReader {
  listPids(): number[];
  readCwd(pid: number): string;
  readStat(pid: number): ProcStat;
  readUid(pid: number): number;
  bootTimeMs(): number;
  clockTicksPerSecond(): number;
  selfUid(): number;
  selfPid(): number;
  /** Raw NUL-separated /proc/<pid>/environ (node-timeout ownership). */
  readEnviron?(pid: number): string;
}

export type KillFn = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;

export interface TeardownOptions {
  readonly reader?: ProcReader;
  readonly platform?: NodeJS.Platform;
  readonly kill?: KillFn;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  /** Start-time floor (epoch ms). Defaults to the run's started_at. */
  readonly floorMs?: number;
  readonly graceMs?: number;
  readonly confirmMs?: number;
  readonly pollMs?: number;
  /** Resolves true when another active run shares this working path. */
  readonly isPathShared?: () => Promise<boolean>;
}

export interface TeardownResult {
  readonly confirmed: boolean;
  readonly survivors: readonly TeardownSurvivor[];
  readonly signaled: readonly number[];
  readonly confirmedAt?: string;
}

export interface TeardownTarget {
  readonly id: string;
  readonly working_path: string | null;
  readonly started_at: Date | string;
}

function errCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function isGone(error: unknown): boolean {
  const code = errCode(error);
  return code === 'ENOENT' || code === 'ESRCH';
}

let cachedClockTicks: number | undefined;
function systemClockTicks(): number {
  if (cachedClockTicks !== undefined) return cachedClockTicks;
  let ticks = 100;
  try {
    const out = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 }).trim();
    const parsed = Number.parseInt(out, 10);
    if (Number.isInteger(parsed) && parsed > 0) ticks = parsed;
  } catch {
    // getconf unavailable: Linux USER_HZ is 100 on every supported kernel.
  }
  cachedClockTicks = ticks;
  return ticks;
}

/** Parse the content of /proc/<pid>/stat. comm may contain spaces and parens. */
export function parseProcStat(content: string): ProcStat {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < open) {
    throw Object.assign(new Error('stat_unparseable'), { code: 'EPARSE' });
  }
  const comm = content.slice(open + 1, close);
  const rest = content
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state); field N is rest[N - 3].
  const state = rest[0] ?? '';
  const ppid = Number(rest[1]);
  const startTicks = Number(rest[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) {
    throw Object.assign(new Error('stat_unparseable'), { code: 'EPARSE' });
  }
  return { state, ppid, startTicks, comm };
}

/** Real /proc reader. Boot time is btime from /proc/stat refined by /proc/uptime. */
export function createLinuxProcReader(root = '/proc'): ProcReader {
  let bootMs: number | undefined;
  return {
    listPids(): number[] {
      return readdirSync(root)
        .filter(name => /^[0-9]+$/.test(name))
        .map(Number);
    },
    readCwd(pid: number): string {
      return readlinkSync(`${root}/${String(pid)}/cwd`);
    },
    readStat(pid: number): ProcStat {
      return parseProcStat(readFileSync(`${root}/${String(pid)}/stat`, 'utf8'));
    },
    readUid(pid: number): number {
      const status = readFileSync(`${root}/${String(pid)}/status`, 'utf8');
      const line = status.split('\n').find(l => l.startsWith('Uid:'));
      const uid = line ? Number(line.slice(4).trim().split(/\s+/)[0]) : NaN;
      if (!Number.isInteger(uid)) {
        throw Object.assign(new Error('uid_unparseable'), { code: 'EPARSE' });
      }
      return uid;
    },
    bootTimeMs(): number {
      if (bootMs !== undefined) return bootMs;
      const stat = readFileSync(`${root}/stat`, 'utf8');
      const line = stat.split('\n').find(l => l.startsWith('btime '));
      const btime = line ? Number(line.slice(6).trim()) : NaN;
      if (!Number.isFinite(btime)) {
        throw Object.assign(new Error('btime_unreadable'), { code: 'EPARSE' });
      }
      let value = btime * 1000;
      // btime is truncated to whole seconds; /proc/uptime gives centiseconds.
      // Use the precise value only when it agrees with btime.
      try {
        const uptime = Number(readFileSync(`${root}/uptime`, 'utf8').trim().split(/\s+/)[0]);
        const precise = Date.now() - uptime * 1000;
        if (Number.isFinite(precise) && Math.abs(precise - value) < 1500) value = precise;
      } catch {
        // keep btime
      }
      bootMs = value;
      return value;
    },
    clockTicksPerSecond: systemClockTicks,
    selfUid(): number {
      const uid = process.getuid?.();
      if (uid === undefined) throw Object.assign(new Error('uid_unavailable'), { code: 'EPARSE' });
      return uid;
    },
    selfPid(): number {
      return process.pid;
    },
    readEnviron(pid: number): string {
      return readFileSync(`${root}/${String(pid)}/environ`, 'latin1');
    },
  };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function stripDeleted(path: string): string {
  return path.endsWith(' (deleted)') ? path.slice(0, -' (deleted)'.length) : path;
}

export function isPathInside(candidate: string, root: string): boolean {
  const c = resolve(candidate);
  const r = resolve(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

function startMs(reader: ProcReader, stat: ProcStat): number {
  return reader.bootTimeMs() + (stat.startTicks * 1000) / reader.clockTicksPerSecond();
}

interface OwnedProcess {
  readonly pid: number;
  readonly startTicks: number;
  readonly comm: string;
  readonly uid: number;
}

interface ScanResult {
  readonly owned: OwnedProcess[];
  readonly blockers: TeardownSurvivor[];
  readonly incomplete: number;
}

function skippedPids(reader: ProcReader): Set<number> {
  const skip = new Set<number>([0, 1]);
  const self = reader.selfPid();
  skip.add(self);
  let pid = self;
  for (let i = 0; i < 64; i++) {
    let ppid: number;
    try {
      ppid = reader.readStat(pid).ppid;
    } catch {
      break;
    }
    if (!Number.isInteger(ppid) || ppid <= 1 || skip.has(ppid)) break;
    skip.add(ppid);
    pid = ppid;
  }
  return skip;
}

type Membership = (pid: number) => 'yes' | 'no' | 'unknown';

/**
 * Scan for processes whose cwd is inside `workingPath`. Owned = same uid and
 * started strictly after `floorMs`; every other observable holder is a blocker.
 * When `member` is given, only processes it reports as members are considered;
 * 'unknown' membership of a same-uid holder makes the scan incomplete.
 */
function scanWorktree(
  reader: ProcReader,
  workingPath: string,
  floorMs: number,
  member?: Membership
): ScanResult {
  const root = canonicalPath(workingPath);
  const skip = skippedPids(reader);
  const selfUid = reader.selfUid();
  const owned: OwnedProcess[] = [];
  const blockers: TeardownSurvivor[] = [];
  let incomplete = 0;
  for (const pid of reader.listPids()) {
    if (skip.has(pid)) continue;
    let cwd: string;
    try {
      cwd = stripDeleted(reader.readCwd(pid));
    } catch (error) {
      if (isGone(error)) continue;
      // cwd unreadable: same uid (or unknown uid) started after the floor means we
      // cannot prove absence (bdc-xo#3569: an orphan pipeline of the finished run).
      // A non-dumpable same-uid process that started at or before the floor (a
      // session manager such as `systemd --user`) is not observable and is skipped.
      try {
        if (reader.readUid(pid) !== selfUid) continue;
      } catch (uidError) {
        if (isGone(uidError)) continue;
      }
      try {
        const unreadableStat = reader.readStat(pid);
        if (!(startMs(reader, unreadableStat) > floorMs)) continue;
      } catch (statError) {
        if (isGone(statError)) continue;
      }
      incomplete++;
      blockers.push({ pid, reason: 'scan_incomplete' });
      continue;
    }
    if (!isPathInside(cwd, root) && !isPathInside(cwd, workingPath)) continue;
    let stat: ProcStat;
    let uid: number;
    try {
      stat = reader.readStat(pid);
      uid = reader.readUid(pid);
    } catch (error) {
      if (isGone(error)) continue;
      incomplete++;
      blockers.push({ pid, reason: 'scan_incomplete' });
      continue;
    }
    if (stat.state === 'Z') continue;
    if (member) {
      const m = member(pid);
      if (m === 'no') continue;
      if (m === 'unknown') {
        if (uid === selfUid) {
          incomplete++;
          blockers.push({ pid, comm: stat.comm, reason: 'scan_incomplete' });
        }
        continue;
      }
    }
    if (uid !== selfUid) {
      blockers.push({ pid, comm: stat.comm, reason: 'foreign_uid' });
    } else if (!(startMs(reader, stat) > floorMs)) {
      blockers.push({ pid, comm: stat.comm, reason: 'predates_run' });
    } else {
      owned.push({ pid, startTicks: stat.startTicks, comm: stat.comm, uid });
    }
  }
  return { owned, blockers, incomplete };
}

/**
 * N2: re-read identity immediately before a signal -- same start time (a reused
 * pid has a different one), cwd still inside the worktree, same real uid, not a
 * zombie. Any change, any unreadable field, or a vanished pid fails the check.
 */
function stillSame(reader: ProcReader, proc: OwnedProcess, workingPath: string): boolean {
  try {
    const stat = reader.readStat(proc.pid);
    if (stat.startTicks !== proc.startTicks || stat.state === 'Z') return false;
    if (reader.readUid(proc.pid) !== proc.uid) return false;
    const cwd = stripDeleted(reader.readCwd(proc.pid));
    return isPathInside(cwd, canonicalPath(workingPath)) || isPathInside(cwd, workingPath);
  } catch {
    return false;
  }
}

function isAlive(reader: ProcReader, proc: OwnedProcess): boolean {
  try {
    const stat = reader.readStat(proc.pid);
    return stat.startTicks === proc.startTicks && stat.state !== 'Z';
  } catch {
    return false;
  }
}

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function safeSignal(
  reader: ProcReader,
  kill: KillFn,
  proc: OwnedProcess,
  workingPath: string,
  signal: 'SIGTERM' | 'SIGKILL',
  signaled: Set<number>,
  identityChanged: Map<number, OwnedProcess>
): void {
  const pid = proc.pid;
  if (!Number.isInteger(pid) || pid <= 1 || pid === reader.selfPid()) return;
  if (!stillSame(reader, proc, workingPath)) {
    // Ownership is no longer proven: never signal, report as identity_changed.
    identityChanged.set(pid, proc);
    return;
  }
  try {
    kill(pid, signal);
    signaled.add(pid);
  } catch (error) {
    if (!isGone(error)) {
      log.warn({ err: error as Error, pid, signal }, 'run_teardown_signal_failed');
    }
  }
}

async function terminate(
  reader: ProcReader,
  kill: KillFn,
  sleep: (ms: number) => Promise<void>,
  targets: readonly OwnedProcess[],
  workingPath: string,
  opts: { graceMs: number; confirmMs: number; pollMs: number }
): Promise<{ survivors: OwnedProcess[]; signaled: number[]; identityChanged: OwnedProcess[] }> {
  const signaled = new Set<number>();
  const changed = new Map<number, OwnedProcess>();
  for (const proc of targets) {
    safeSignal(reader, kill, proc, workingPath, 'SIGTERM', signaled, changed);
  }
  let alive = targets.filter(p => !changed.has(p.pid) && isAlive(reader, p));
  let waited = 0;
  while (alive.length > 0 && waited < opts.graceMs) {
    await sleep(opts.pollMs);
    waited += opts.pollMs;
    alive = alive.filter(p => isAlive(reader, p));
  }
  if (alive.length > 0) {
    for (const proc of alive) {
      safeSignal(reader, kill, proc, workingPath, 'SIGKILL', signaled, changed);
    }
    alive = alive.filter(p => !changed.has(p.pid));
    waited = 0;
    while (alive.length > 0 && waited < opts.confirmMs) {
      await sleep(opts.pollMs);
      waited += opts.pollMs;
      alive = alive.filter(p => isAlive(reader, p));
    }
  }
  return { survivors: alive, signaled: [...signaled], identityChanged: [...changed.values()] };
}

function unverifiable(): TeardownResult {
  return { confirmed: false, survivors: [{ reason: 'teardown_unverifiable' }], signaled: [] };
}

function runFloorMs(run: TeardownTarget): number {
  const ms = parseDbTimestamp(run.started_at);
  return Number.isFinite(ms) ? ms : 0;
}

function readerFor(opts: TeardownOptions): ProcReader | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') return null;
  const reader = opts.reader ?? createLinuxProcReader();
  try {
    reader.listPids();
    reader.bootTimeMs();
    reader.selfUid();
    reader.clockTicksPerSecond();
  } catch {
    return null;
  }
  return reader;
}

/**
 * End run `run`'s process tree per invariants N1-N3 and N7. Never throws.
 * Total time is bounded by graceMs + confirmMs plus two scans.
 */
export async function endRunProcessTree(
  run: TeardownTarget,
  opts: TeardownOptions = {}
): Promise<TeardownResult> {
  try {
    const reader = readerFor(opts);
    if (!reader) return unverifiable();
    const now = opts.now ?? ((): Date => new Date());
    if (!run.working_path) {
      return { confirmed: true, survivors: [], signaled: [], confirmedAt: now().toISOString() };
    }
    if (opts.isPathShared) {
      let shared = true;
      try {
        shared = await opts.isPathShared();
      } catch {
        shared = true;
      }
      if (shared) {
        return {
          confirmed: false,
          survivors: [{ reason: 'path_shared_with_active_run' }],
          signaled: [],
        };
      }
    }
    // A removed worktree is still scanned: a live cwd reads "<path> (deleted)".
    const floorMs = opts.floorMs ?? runFloorMs(run);
    const kill = opts.kill ?? defaultKill;
    const sleep = opts.sleep ?? defaultSleep;
    const timing = {
      graceMs: opts.graceMs ?? TERMINATION_GRACE_MS,
      confirmMs: opts.confirmMs ?? TERMINATION_CONFIRM_MS,
      pollMs: opts.pollMs ?? TERMINATION_POLL_MS,
    };
    const first = scanWorktree(reader, run.working_path, floorMs);
    const { survivors, signaled, identityChanged } = await terminate(
      reader,
      kill,
      sleep,
      first.owned,
      run.working_path,
      timing
    );
    // A final scan catches anything forked during teardown; it is not signaled again.
    const final = scanWorktree(reader, run.working_path, floorMs);
    const list: TeardownSurvivor[] = [];
    const seen = new Set<string>();
    const push = (s: TeardownSurvivor): void => {
      const key = `${String(s.pid)}:${s.reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(s);
    };
    for (const s of identityChanged) push({ pid: s.pid, comm: s.comm, reason: 'identity_changed' });
    for (const s of survivors) push({ pid: s.pid, comm: s.comm, reason: 'survived_kill' });
    for (const p of final.owned) push({ pid: p.pid, comm: p.comm, reason: 'survived_kill' });
    for (const b of [...first.blockers, ...final.blockers]) push(b);
    if (list.length > 0) return { confirmed: false, survivors: list, signaled };
    return { confirmed: true, survivors: [], signaled, confirmedAt: now().toISOString() };
  } catch (error) {
    log.error({ err: error as Error, runId: run.id }, 'run_teardown_failed');
    return { confirmed: false, survivors: [{ reason: 'scan_incomplete' }], signaled: [] };
  }
}

/** Metadata keys a teardown result writes onto the run row. */
export function teardownMetadata(result: TeardownResult): Record<string, unknown> {
  if (result.confirmed) {
    return {
      teardown_confirmed_at: result.confirmedAt ?? new Date().toISOString(),
      teardown_survivors: [],
    };
  }
  return { teardown_survivors: result.survivors.map(s => ({ ...s })) };
}

/** True when run metadata records a confirmed teardown with no survivors. */
export function isTeardownConfirmed(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  const survivors = metadata.teardown_survivors;
  if (Array.isArray(survivors) && survivors.length > 0) return false;
  return typeof metadata.teardown_confirmed_at === 'string';
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status);
}

/**
 * True when another active run (not `run`) holds the same working_path. Uses
 * the existing path-lock query with a far-future tiebreak so every other active
 * row qualifies. A missing store method means no shared-path data (false).
 */
export async function otherActiveRunSharesPath(
  store: Pick<IWorkflowStore, 'getActiveWorkflowRunByPath'>,
  run: TeardownTarget
): Promise<boolean> {
  if (!run.working_path || typeof store.getActiveWorkflowRunByPath !== 'function') return false;
  const other = await store.getActiveWorkflowRunByPath(run.working_path, {
    id: run.id,
    startedAt: new Date('9999-12-31T00:00:00.000Z'),
  });
  return other !== null && other !== undefined && other.id !== run.id;
}

/**
 * Run teardown before a terminal status write and persist its metadata.
 * Returns the metadata to merge into the terminal write. Never throws.
 */
export async function finalizeRunTeardown(
  store: IWorkflowStore,
  run: Pick<WorkflowRun, 'id' | 'working_path' | 'started_at'>,
  opts: TeardownOptions = {}
): Promise<Record<string, unknown>> {
  // A run without a working path owns no process (identity rule (a)); there is
  // nothing to tear down and nothing to record. Production runs always carry one.
  if (!run.working_path) return {};
  const target: TeardownTarget = {
    id: run.id,
    working_path: run.working_path,
    started_at: run.started_at,
  };
  const result = await endRunProcessTree(target, {
    isPathShared: () => otherActiveRunSharesPath(store, target),
    ...opts,
  });
  const metadata = teardownMetadata(result);
  if (!result.confirmed) {
    log.warn({ runId: run.id, survivors: result.survivors }, 'run_teardown_unconfirmed');
  }
  try {
    await store.updateWorkflowRun(run.id, { metadata });
  } catch (error) {
    log.error({ err: error as Error, runId: run.id }, 'run_teardown_metadata_write_failed');
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Node-specific timeout teardown (Scope IN item 2, Overseer review of #4113)
// ---------------------------------------------------------------------------

export const NODE_TOKEN_ENV = 'ARCHON_NODE_RUN_ID';

/** Membership test: does pid's environment carry `NODE_TOKEN_ENV=<token>`? */
function nodeTokenMembership(reader: ProcReader, token: string): Membership {
  const needle = `${NODE_TOKEN_ENV}=${token}`;
  return pid => {
    if (!reader.readEnviron) return 'unknown';
    try {
      return reader.readEnviron(pid).split('\0').includes(needle) ? 'yes' : 'no';
    } catch (error) {
      return isGone(error) ? 'no' : 'unknown';
    }
  };
}

export interface NodeTimeoutTeardownInput {
  readonly run: TeardownTarget;
  readonly nodeStartMs: number;
  /** The ARCHON_NODE_RUN_ID value the timed-out node was spawned with. */
  readonly nodeToken: string;
}

/**
 * After a node timeout, signal only that node's processes (env token match),
 * each still required to be run-owned against the node start time. Never throws.
 */
export async function endNodeProcessTree(
  input: NodeTimeoutTeardownInput,
  opts: TeardownOptions = {}
): Promise<TeardownResult> {
  try {
    const reader = readerFor(opts);
    if (!reader) return unverifiable();
    if (!input.run.working_path || !input.nodeToken) {
      return { confirmed: true, survivors: [], signaled: [] };
    }
    const member = nodeTokenMembership(reader, input.nodeToken);
    const wp = input.run.working_path;
    const kill = opts.kill ?? defaultKill;
    const sleep = opts.sleep ?? defaultSleep;
    const timing = {
      graceMs: opts.graceMs ?? TERMINATION_GRACE_MS,
      confirmMs: opts.confirmMs ?? TERMINATION_CONFIRM_MS,
      pollMs: opts.pollMs ?? TERMINATION_POLL_MS,
    };
    const scan = scanWorktree(reader, wp, input.nodeStartMs, member);
    const first = await terminate(reader, kill, sleep, scan.owned, wp, timing);
    // Final membership scan (node marker + cwd), as run teardown does: a process
    // forked during teardown (e.g. from a SIGTERM handler) carries the marker.
    // One more verified kill round reaps it; anything still owned afterwards is a
    // survivor, so the node teardown never confirms on the initial scan alone.
    const rescan = scanWorktree(reader, wp, input.nodeStartMs, member);
    const second = await terminate(reader, kill, sleep, rescan.owned, wp, timing);
    const final = scanWorktree(reader, wp, input.nodeStartMs, member);
    const signaled = [...new Set([...first.signaled, ...second.signaled])];
    const list: TeardownSurvivor[] = [];
    const seen = new Set<string>();
    const push = (s: TeardownSurvivor): void => {
      const key = `${String(s.pid)}:${s.reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(s);
    };
    for (const s of [...first.identityChanged, ...second.identityChanged]) {
      push({ pid: s.pid, comm: s.comm, reason: 'identity_changed' });
    }
    for (const s of [...first.survivors, ...second.survivors, ...final.owned]) {
      push({ pid: s.pid, comm: s.comm, reason: 'survived_kill' });
    }
    for (const b of [...scan.blockers, ...rescan.blockers, ...final.blockers]) push(b);
    return list.length > 0
      ? { confirmed: false, survivors: list, signaled }
      : { confirmed: true, survivors: [], signaled };
  } catch (error) {
    log.error({ err: error as Error, runId: input.run.id }, 'node_teardown_failed');
    return { confirmed: false, survivors: [{ reason: 'scan_incomplete' }], signaled: [] };
  }
}

/** Human-readable suffix for a node timeout whose teardown did not confirm. */
export function describeNodeTeardown(result: TeardownResult): string {
  if (result.confirmed) return '';
  const reasons = [...new Set(result.survivors.map(s => s.reason))].join(', ');
  return `; node teardown unconfirmed (${String(result.survivors.length)} survivor(s): ${reasons}) -- not a skippable timeout`;
}

// ---------------------------------------------------------------------------
// Terminal-run lease reconciler (N5)
// ---------------------------------------------------------------------------

/** Unreleased leases on terminal runs (portable SQL; $n placeholders). */
export const TERMINAL_RUN_LEASES_SQL = `SELECT l.run_id AS run_id, r.status AS status, r.working_path AS working_path,
       r.started_at AS started_at, r.completed_at AS completed_at
FROM remote_agent_run_leases l
JOIN remote_agent_workflow_runs r ON r.id = l.run_id
WHERE l.released_at IS NULL
  AND r.status IN ('completed', 'failed', 'escalated', 'cancelled')
ORDER BY l.run_id`;

/**
 * Release one terminal run's lease. The EXISTS guard re-checks the run is still
 * terminal so a lease re-claimed by a resumed run is never released.
 */
export const RELEASE_TERMINAL_RUN_LEASE_SQL = `UPDATE remote_agent_run_leases SET released_at = $2
WHERE run_id = $1 AND released_at IS NULL
  AND EXISTS (SELECT 1 FROM remote_agent_workflow_runs r WHERE r.id = $1
              AND r.status IN ('completed', 'failed', 'escalated', 'cancelled'))`;

export interface TerminalRunLeaseRecord {
  readonly runId: string;
  readonly status: string;
  readonly workingPath: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface TerminalLeaseReconcileReport {
  observed: number;
  released: number;
  held: { runId: string; reason: string }[];
}

/**
 * Release leases left on terminal runs (N5). For each unreleased lease whose run
 * is terminal and completed more than 600 s ago, scan the run's worktree without
 * signaling anything; release only when no holder, no blocker and a complete
 * scan. A missing directory is scanned too: a live process can keep its cwd in a
 * deleted worktree (the link reads '<path> (deleted)'). Teardown that cannot be
 * verified keeps the lease. Never touches a non-terminal run.
 */
export async function releaseTerminalRunLeases(
  store: Pick<IWorkflowStore, 'listUnreleasedTerminalRunLeases' | 'releaseTerminalRunLease'>,
  opts: TeardownOptions & {
    readonly minAgeMs?: number;
  } = {}
): Promise<TerminalLeaseReconcileReport> {
  const report: TerminalLeaseReconcileReport = { observed: 0, released: 0, held: [] };
  if (!store.listUnreleasedTerminalRunLeases || !store.releaseTerminalRunLease) return report;
  const now = opts.now ?? ((): Date => new Date());
  const minAgeMs = opts.minAgeMs ?? TERMINAL_LEASE_MIN_AGE_MS;
  const candidates = await store.listUnreleasedTerminalRunLeases();
  report.observed = candidates.length;
  for (const lease of candidates) {
    if (!isTerminalRunStatus(lease.status)) {
      report.held.push({ runId: lease.runId, reason: 'not_terminal' });
      continue;
    }
    const completedMs = lease.completedAt ? parseDbTimestamp(lease.completedAt) : NaN;
    if (!Number.isFinite(completedMs) || now().getTime() - completedMs < minAgeMs) {
      report.held.push({ runId: lease.runId, reason: 'too_recent' });
      continue;
    }
    let clear = false;
    if (!lease.workingPath) {
      // No working path: the run owns no process (identity rule (a)).
      clear = true;
    } else {
      const reader = readerFor(opts);
      if (!reader) {
        report.held.push({ runId: lease.runId, reason: 'teardown_unverifiable' });
        continue;
      }
      try {
        const floor = parseDbTimestamp(lease.startedAt);
        const scan = scanWorktree(reader, lease.workingPath, Number.isFinite(floor) ? floor : 0);
        clear = scan.owned.length === 0 && scan.blockers.length === 0 && scan.incomplete === 0;
        if (!clear) {
          report.held.push({
            runId: lease.runId,
            reason: scan.incomplete > 0 ? 'scan_incomplete' : 'holder_present',
          });
          continue;
        }
      } catch {
        report.held.push({ runId: lease.runId, reason: 'scan_incomplete' });
        continue;
      }
    }
    if (clear) {
      const released = await store.releaseTerminalRunLease({
        runId: lease.runId,
        releasedAt: now().toISOString(),
      });
      if (released) report.released += 1;
      else report.held.push({ runId: lease.runId, reason: 'release_race_lost' });
    }
  }
  return report;
}
