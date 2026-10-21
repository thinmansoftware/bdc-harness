import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import { getDatabase } from '../db/connection';
import type { IDatabase } from '../db/adapters/types';
import { resolveServiceGitHubAuth, type GitHubService } from './service-identity';

export interface GitHubApiObservation {
  service: GitHubService;
  poolId: string;
  resource: string;
  status: number;
  limit?: number;
  remaining?: number;
  reset?: number;
  rateLimited?: boolean;
  permissionFallback?: boolean;
  observedAt?: number;
  /** Secondary-limit retry deadline, distinct from the quota reset header. */
  backoffUntil?: number;
}

interface UsageAggregate {
  hourBucket: string;
  service: GitHubService;
  poolId: string;
  resource: string;
  calls: number;
  rateLimited: number;
  permissionFallbacks: number;
}

const usage = new Map<string, UsageAggregate>();
const poolState = new Map<string, GitHubApiObservation>();
const backoff = new Map<string, number>();
let lastFlushAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;

function finiteHeader(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function observationFromResponse(
  service: GitHubService,
  poolId: string,
  response: Response,
  extra: Pick<GitHubApiObservation, 'permissionFallback'> = {}
): GitHubApiObservation {
  const remaining = finiteHeader(response.headers.get('x-ratelimit-remaining'));
  const reset = finiteHeader(response.headers.get('x-ratelimit-reset'));
  const retryAfter = response.headers.get('retry-after');
  const retrySeconds = finiteHeader(retryAfter);
  const retryDate = retryAfter ? Date.parse(retryAfter) : NaN;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && (remaining === 0 || response.headers.has('retry-after')));
  return {
    service,
    poolId,
    resource: response.headers.get('x-ratelimit-resource') || 'core',
    status: response.status,
    limit: finiteHeader(response.headers.get('x-ratelimit-limit')),
    remaining,
    reset,
    rateLimited,
    ...(rateLimited
      ? {
          backoffUntil:
            retrySeconds !== undefined && retrySeconds >= 0
              ? Date.now() + retrySeconds * 1000
              : Number.isFinite(retryDate)
                ? retryDate
                : reset
                  ? reset * 1000
                  : Date.now() + 60_000,
        }
      : {}),
    permissionFallback: extra.permissionFallback,
  };
}

export function recordGitHubApiCall(observation: GitHubApiObservation): void {
  const observedAt = observation.observedAt ?? Date.now();
  const hourBucket = new Date(Math.floor(observedAt / 3_600_000) * 3_600_000).toISOString();
  const key = [hourBucket, observation.service, observation.poolId, observation.resource].join('|');
  const row = usage.get(key) ?? {
    hourBucket,
    service: observation.service,
    poolId: observation.poolId,
    resource: observation.resource,
    calls: 0,
    rateLimited: 0,
    permissionFallbacks: 0,
  };
  row.calls += 1;
  row.rateLimited += observation.rateLimited ? 1 : 0;
  row.permissionFallbacks += observation.permissionFallback ? 1 : 0;
  usage.set(key, row);
  if (
    observation.limit !== undefined ||
    observation.remaining !== undefined ||
    observation.reset !== undefined
  ) {
    poolState.set(`${observation.poolId}|${observation.resource}`, {
      ...observation,
      observedAt,
    });
  }
  if (observation.rateLimited) {
    const until =
      observation.backoffUntil ??
      (observation.reset ? observation.reset * 1000 : observedAt + 60_000);
    backoff.set(`${observation.poolId}|${observation.resource}`, until);
    // Durable gate in the existing resource-keyed table. Keep measured quota
    // remaining/reset untouched, including secondary limits with quota left.
    poolState.set(`${observation.poolId}|backoff:${observation.resource}`, {
      ...observation,
      resource: `backoff:${observation.resource}`,
      limit: undefined,
      remaining: 0,
      reset: until / 1000,
      observedAt,
    });
  }
  scheduleFlush();
}

export function assertGitHubPoolAvailable(
  poolId: string,
  resource = 'core',
  now = Date.now()
): void {
  const until = backoff.get(`${poolId}|${resource}`) ?? 0;
  if (until > now) throw new Error(`github_pool_backoff:${poolId}/${resource}:${until}`);
}

/** Read shared state afresh: command drivers do not share the server's Map. */
export async function assertPersistedGitHubPoolAvailable(
  poolId: string,
  resources: readonly string[],
  db: IDatabase = getDatabase(),
  now = Date.now()
): Promise<void> {
  for (const resource of resources) {
    assertGitHubPoolAvailable(poolId, resource, now);
    const result = await db.query<{ remaining: number | null; reset_at: string | null }>(
      'SELECT remaining, reset_at FROM github_api_pool_state WHERE pool_id = $1 AND (resource = $2 OR resource = $3)',
      [poolId, resource, `backoff:${resource}`]
    );
    for (const state of result.rows) {
      const until = state.reset_at ? Date.parse(state.reset_at) : 0;
      if (state.remaining === 0 && until > now) {
        throw new Error(`github_pool_backoff:${poolId}/${resource}:${until}`);
      }
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  const delay = Math.max(0, 60_000 - (Date.now() - lastFlushAt));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushGitHubApiMeter().catch(() => undefined);
  }, delay);
  flushTimer.unref?.();
}

export async function flushGitHubApiMeter(db: IDatabase = getDatabase()): Promise<void> {
  while (flushInFlight) await flushInFlight.catch(() => undefined);
  if (usage.size === 0 && poolState.size === 0) return;
  const operation = flushBatch(db);
  flushInFlight = operation;
  try {
    await operation;
  } finally {
    if (flushInFlight === operation) flushInFlight = null;
  }
}

async function flushBatch(db: IDatabase): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const usageRows = [...usage.values()];
  const stateRows = [...poolState.values()];
  usage.clear();
  poolState.clear();
  try {
    await db.withTransaction(async query => {
      for (const row of usageRows) {
        await query(
          `INSERT INTO github_api_usage (hour_bucket, service, pool_id, resource, calls, rate_limited, permission_fallbacks)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (hour_bucket, service, pool_id, resource) DO UPDATE SET
             calls = github_api_usage.calls + excluded.calls,
             rate_limited = github_api_usage.rate_limited + excluded.rate_limited,
             permission_fallbacks = github_api_usage.permission_fallbacks + excluded.permission_fallbacks`,
          [
            row.hourBucket,
            row.service,
            row.poolId,
            row.resource,
            row.calls,
            row.rateLimited,
            row.permissionFallbacks,
          ]
        );
      }
      for (const row of stateRows) {
        await query(
          `INSERT INTO github_api_pool_state (pool_id, resource, "limit", remaining, reset_at, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (pool_id, resource) DO UPDATE SET
             "limit" = excluded."limit", remaining = excluded.remaining,
             reset_at = excluded.reset_at, observed_at = excluded.observed_at
           WHERE github_api_pool_state.observed_at <= excluded.observed_at`,
          [
            row.poolId,
            row.resource,
            row.limit ?? null,
            row.remaining ?? null,
            row.reset ? new Date(row.reset * 1000).toISOString() : null,
            new Date(row.observedAt ?? Date.now()).toISOString(),
          ]
        );
      }
    });
    lastFlushAt = Date.now();
  } catch (error) {
    for (const row of usageRows) {
      const key = [row.hourBucket, row.service, row.poolId, row.resource].join('|');
      const current = usage.get(key);
      if (current) {
        current.calls += row.calls;
        current.rateLimited += row.rateLimited;
        current.permissionFallbacks += row.permissionFallbacks;
      } else usage.set(key, row);
    }
    for (const row of stateRows) {
      const key = `${row.poolId}|${row.resource}`;
      if ((poolState.get(key)?.observedAt ?? 0) <= (row.observedAt ?? 0)) poolState.set(key, row);
    }
    throw error;
  }
}

export function resetGitHubApiMeterForTests(): void {
  usage.clear();
  poolState.clear();
  backoff.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (laneMeterTimer) clearInterval(laneMeterTimer);
  laneMeterTimer = null;
  laneIngestTail = Promise.resolve();
  lastFlushAt = 0;
}

const LANE_METER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LANE_METER_FILE = /^[0-9]+-[0-9]+-[0-9a-f]+\.json$/;
const LANE_METER_MAX_BYTES = 1024;
let laneMeterTimer: ReturnType<typeof setInterval> | null = null;
let laneIngestTail: Promise<void> = Promise.resolve();
let meterLog: ReturnType<typeof createLogger> | undefined;

function getMeterLog(): ReturnType<typeof createLogger> {
  if (!meterLog) meterLog = createLogger('github.metering');
  return meterLog;
}

/** Lane-writable spool. The server process is the only writer to archon.db. */
export function laneMeterSpoolDir(): string {
  return join(getArchonHome(), 'artifacts', 'lane-meter');
}

export function currentGitHubHourBucket(now = Date.now()): string {
  return new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
}

/**
 * Persist one lane observation as a file. Does not open the database.
 * Service and pool id are omitted: the server stamps run_nodes identity at ingest.
 */
export function writeLaneMeterObservation(
  observation: GitHubApiObservation,
  directory = laneMeterSpoolDir()
): void {
  mkdirSync(directory, { recursive: true });
  const name = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
  const path = join(directory, name);
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      resource: observation.resource,
      status: observation.status,
    }),
    { flag: 'wx' }
  );
  try {
    chmodSync(path, 0o640);
  } catch {
    // The create mode is already owner-readable. Group mode is best-effort.
  }
}

interface AcceptedLaneMeter {
  resource: string;
  status: number;
}

interface SpoolClaim {
  path: string;
  dev: number;
  ino: number;
  row: AcceptedLaneMeter;
}

function acceptLaneMeterPayload(raw: string): AcceptedLaneMeter | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1) return undefined;
  // Lane-supplied service and poolId are never read. Identity is server-side.
  if (typeof row.resource !== 'string' || !LANE_METER_ID.test(row.resource)) return undefined;
  if (
    typeof row.status !== 'number' ||
    !Number.isInteger(row.status) ||
    row.status < 0 ||
    row.status > 599
  ) {
    return undefined;
  }
  return {
    resource: row.resource,
    status: row.status,
  };
}

/** Linux lane isolation requires O_NOFOLLOW. Windows CI has no lane uid split. */
function spoolOpenFlags(): number {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (process.platform !== 'win32') {
    if (typeof noFollow !== 'number') throw new Error('lane_meter_nofollow_unavailable');
    return constants.O_RDONLY | noFollow;
  }
  return constants.O_RDONLY;
}

function openSpoolNoFollow(path: string): number {
  return openSync(path, spoolOpenFlags());
}

function sameSpoolInode(
  path: string,
  dev: number,
  ino: number
): { dev: number; ino: number } | undefined {
  try {
    const listed = lstatSync(path);
    if (listed.isSymbolicLink() || !listed.isFile()) return undefined;
    if (listed.dev !== dev || listed.ino !== ino) return undefined;
    return { dev: listed.dev, ino: listed.ino };
  } catch {
    return undefined;
  }
}

function unlinkClaimed(path: string, dev: number, ino: number): void {
  if (!sameSpoolInode(path, dev, ino)) return;
  let fd: number | undefined;
  try {
    fd = openSpoolNoFollow(path);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== dev || opened.ino !== ino) return;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!sameSpoolInode(path, dev, ino)) return;
  try {
    unlinkSync(path);
  } catch {
    // Leave the file. The next ingest retries it.
  }
}

function readSpoolClaim(
  directory: string,
  name: string
): { path: string; raw: string; dev: number; ino: number } | undefined {
  if (!LANE_METER_FILE.test(name) || name.includes('/') || name.includes('\\')) return undefined;
  const path = join(directory, name);
  let listed: ReturnType<typeof lstatSync>;
  try {
    listed = lstatSync(path);
  } catch {
    return undefined;
  }
  if (listed.isSymbolicLink()) {
    try {
      unlinkSync(path);
    } catch {
      // A remaining symlink is skipped again on the next tick.
    }
    return undefined;
  }
  if (!listed.isFile()) return undefined;
  let fd: number | undefined;
  try {
    fd = openSpoolNoFollow(path);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino)
      return undefined;
    if (opened.size > LANE_METER_MAX_BYTES) {
      closeSync(fd);
      fd = undefined;
      unlinkClaimed(path, opened.dev, opened.ino);
      return undefined;
    }
    return { path, raw: readFileSync(fd, 'utf8'), dev: opened.dev, ino: opened.ino };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveRunNodesMeterIdentity(): { service: 'run_nodes'; poolId: string } {
  const auth = resolveServiceGitHubAuth('run_nodes');
  if (auth.service !== 'run_nodes' || auth.poolId === 'none' || auth.poolId.length === 0) {
    throw new Error('lane_meter_identity_unresolved');
  }
  return { service: 'run_nodes', poolId: auth.poolId };
}

async function ingestLaneGitHubMeterSpoolOnce(db: IDatabase, directory: string): Promise<number> {
  let listed: ReturnType<typeof lstatSync>;
  try {
    listed = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  if (!listed.isDirectory() || listed.isSymbolicLink()) return 0;
  const names = readdirSync(directory);
  const accepted: SpoolClaim[] = [];
  for (const name of names) {
    const claim = readSpoolClaim(directory, name);
    if (!claim) continue;
    const row = acceptLaneMeterPayload(claim.raw);
    if (!row) {
      unlinkClaimed(claim.path, claim.dev, claim.ino);
      continue;
    }
    accepted.push({ path: claim.path, dev: claim.dev, ino: claim.ino, row });
  }
  if (accepted.length === 0) return 0;
  const identity = resolveRunNodesMeterIdentity();
  const hourBucket = currentGitHubHourBucket();
  await db.withTransaction(async query => {
    for (const item of accepted) {
      await query(
        `INSERT INTO github_api_usage (hour_bucket, service, pool_id, resource, calls, rate_limited, permission_fallbacks)
         VALUES ($1, $2, $3, $4, 1, 0, 0)
         ON CONFLICT (hour_bucket, service, pool_id, resource) DO UPDATE SET
           calls = github_api_usage.calls + 1`,
        [hourBucket, identity.service, identity.poolId, item.row.resource]
      );
    }
  });
  for (const item of accepted) unlinkClaimed(item.path, item.dev, item.ino);
  return accepted.length;
}

/**
 * Record lane observations from the spool. Each accepted file increments
 * calls by 1 under the server-resolved run_nodes pool. Lane-supplied service,
 * pool id, counts, hour buckets, and pool-state fields are ignored.
 * Files stay on disk until the database write commits, so a failed ingest retries.
 */
export async function ingestLaneGitHubMeterSpool(
  db: IDatabase = getDatabase(),
  directory = laneMeterSpoolDir()
): Promise<number> {
  const run = laneIngestTail.then(() => ingestLaneGitHubMeterSpoolOnce(db, directory));
  laneIngestTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function startLaneGitHubMeterIngest(intervalMs = 15_000): void {
  if (laneMeterTimer) return;
  const tick = (): void => {
    void ingestLaneGitHubMeterSpool().catch((error: unknown) => {
      getMeterLog().error({ err: error }, 'lane_meter_ingest_failed');
    });
  };
  tick();
  laneMeterTimer = setInterval(tick, intervalMs);
  laneMeterTimer.unref?.();
}
