/**
 * Subscription seat usage probes and the entry gate.
 *
 * Ports the Fuelglass claude/codex/cursor probe contracts (measurement only).
 * A measured 0 is a number. UNKNOWN means the probe could not measure.
 * NOT_APPLICABLE means the seat has no such window. Only a measurement at or
 * above the cutoff refuses a run. An UNKNOWN reading lets the run proceed and
 * raises an operator alert (at most one per seat per hour). Credentials never
 * appear in results, logs or alerts.
 *
 * The gate is always on: there is no off switch (John Ranson, 2026-09-24).
 *
 * WO-HARNESS-FUELGLASS-SEAT-GATE-01
 */
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { createLogger } from '@archon/paths';
import {
  createAuthenticatedMessage,
  type CreateAuthenticatedMessageData,
} from '@archon/core/db/dispatch';
import { getOperatorSetting } from '@archon/core/db/operator-settings';
import { getLatestSeatUsageReading } from '@archon/core/db/seat-usage-readings';

export const SEAT_IDS = ['claude', 'codex', 'cursor'] as const;
export type SeatId = (typeof SEAT_IDS)[number];

/** Default cutoff (John Ranson, 2026-09-24; supersedes the M-171 default of 100). */
export const DEFAULT_SEAT_CUTOFF_PERCENT = 90;
/** Lowest accepted cutoff. */
export const MIN_SEAT_CUTOFF_PERCENT = 1;
/** Highest accepted cutoff. Anything higher would switch the gate off in effect. */
export const MAX_SEAT_CUTOFF_PERCENT = 95;
export const SEAT_CUTOFF_OUT_OF_RANGE = 'seat_cutoff_out_of_range';
export const FUELGLASS_SEAT_CUTOFF_SETTING_KEY = 'fuelglass.seat_cutoff_percent';

const UNKNOWN_ALERT_WINDOW_MS = 60 * 60 * 1000;

const CACHE_TTL_MS = 55_000;
const PROBE_TIMEOUT_MS = 10_000;

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const CURSOR_ENDPOINT = 'https://cursor.com/api/usage-summary';
const CLAUDE_BETA = 'oauth-2025-04-20';
const CURSOR_COOKIE = 'WorkosCursorSessionToken';
const CODEX_SEVEN_DAY_SECONDS = 604800;

const GATE_WINDOWS: Record<SeatId, readonly string[]> = {
  claude: ['five_hour', 'seven_day'],
  codex: ['primary', 'secondary'],
  cursor: ['monthly'],
};

const ENDPOINTS: Record<SeatId, string> = {
  claude: CLAUDE_ENDPOINT,
  codex: CODEX_ENDPOINT,
  cursor: CURSOR_ENDPOINT,
};

export interface SeatWindow {
  name: string;
  used_percent: number;
  remaining_percent: number;
  resets_at: string;
  window_seconds?: number | 'UNKNOWN';
}

export type SevenDayReading =
  | { used_percent: number; remaining_percent: number; resets_at: string }
  | 'UNKNOWN'
  | 'NOT_APPLICABLE';

export interface SeatReading {
  seat: SeatId;
  limit_source: 'measured' | 'UNKNOWN';
  plan?: string;
  windows: SeatWindow[];
  seven_day: SevenDayReading;
  gate_windows: string[];
  note: string;
  probed_at: string;
  endpoint: string;
  http_status?: number;
  allowed?: boolean;
  limit_reached?: boolean;
  /**
   * Codex purchased-credit state from the usage endpoint's top-level
   * `credits` object. When has_credits is true and overage is not blocked,
   * usage past the plan window bills credits instead of stopping.
   */
  credits?: SeatCredits;
  reading_source?: 'probe' | 'pushed';
  observed_at?: string;
}

/**
 * A seat bound only by individual nodes (never the lane's own seat) that is
 * at or over the cutoff, where every node on it declares a failover target
 * with headroom. The run proceeds in degraded mode (WO-HARNESS-SEAT-GATE-
 * HONORS-FIRED-LANE-TIER-01).
 */
export interface SeatGateDegradedSeat {
  seat: SeatId;
  window: string;
  usedPercent: number;
  cutoffPercent: number;
  nodeIds: string[];
  failoverProviders: string[];
}
export interface SeatCredits {
  has_credits: boolean;
  unlimited: boolean;
  overage_limit_reached: boolean;
  balance?: string;
}

export interface SeatGateAllow {
  refused: false;
  unknownSeats: SeatId[];
  /**
   * Seats at or over the cutoff that the gate did NOT refuse because the
   * account bills purchased credits past the window, e.g. `codex:on_credits`.
   * Present only when non-empty.
   */
  onCredits?: string[];
  /** Present only when the gate is evaluated with a lane scope. */
  degradedSeats?: SeatGateDegradedSeat[];
}
export interface SeatGateRefuse {
  refused: true;
  seat: SeatId;
  window: string;
  usedPercent: number;
  cutoffPercent: number;
  unknownSeats: SeatId[];
  /** Same as SeatGateAllow.onCredits; present only when non-empty. */
  onCredits?: string[];
  /**
   * Present only when the gate is evaluated with a lane scope: 'lane' when the
   * refused seat is the lane's own seat, 'node' when it is bound only by nodes.
   */
  role?: 'lane' | 'node';
}
export type SeatGateDecision = SeatGateAllow | SeatGateRefuse;

/** One prompt/command node's resolved provider and its eligible failover target. */
export interface SeatGateNodeBinding {
  nodeId: string;
  providerId: string;
  /** Set only when selectQuotaExhaustionRoute returns a failover route for the node. */
  failoverProvider?: string;
}

/** The lane the run was fired on plus the per-node bindings of its workflow. */
export interface SeatGateScope {
  laneProvider: string;
  nodes: readonly SeatGateNodeBinding[];
}

export interface SeatCutoff {
  percent: number;
  source: 'operator' | 'env' | 'default';
}

export interface PushedCursorReading {
  used_percent: number;
  remaining_percent: number;
  resets_at: string;
  observed_at: string;
  source: string;
}

export interface SeatReadDeps {
  fetch?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  claudeCredentialsFile?: string;
  codexAuthFile?: string;
  /** Cursor only. Omitted in production, which reads the latest stored row. */
  loadPushedReading?: () => Promise<PushedCursorReading | null>;
}

export type SeatUsageReader = (
  seats: readonly SeatId[],
  deps?: SeatReadDeps
) => Promise<Partial<Record<SeatId, SeatReading>>>;

type WarnLog = (obj: Record<string, unknown>, msg: string) => void;

/** Same shape as createAuthenticatedMessage for a fixed system sender. */
export type SeatAlertSend = (
  context: { kind: 'system'; sender: 'dispatch' },
  data: CreateAuthenticatedMessageData
) => Promise<unknown>;

const cache = new Map<SeatId, { at: number; reading: SeatReading }>();
const inflight = new Map<SeatId, Promise<SeatReading>>();
const unknownAlertBucket = new Map<SeatId, number>();
let cutoffOverride: number | null = null;
let invalidCutoffLogged = false;
let invalidPushedMaxAgeLogged = false;

const DEFAULT_PUSHED_READING_MAX_AGE_MINUTES = 30;
const MIN_PUSHED_READING_MAX_AGE_MINUTES = 1;
const MAX_PUSHED_READING_MAX_AGE_MINUTES = 1440;
let readerOverride: SeatUsageReader | null = null;

const defaultWarn: WarnLog = (obj, msg) => {
  createLogger('fuelglass.seat').warn(obj, msg);
};
let warnLog: WarnLog = defaultWarn;

const defaultAlertSend: SeatAlertSend = (context, data) =>
  createAuthenticatedMessage(context, data);
let alertSend: SeatAlertSend = defaultAlertSend;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampPercent(n: number): number {
  return Math.min(100, Math.max(0, n));
}

function nowMs(deps?: SeatReadDeps): number {
  return deps?.now?.() ?? Date.now();
}

function envOf(deps: SeatReadDeps | undefined, key: string): string | undefined {
  if (deps?.env) return deps.env[key];
  return process.env[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function seatForProvider(providerId: string): SeatId | null {
  if (providerId === 'codex-native-strict') return 'codex';
  if (providerId === 'claude' || providerId === 'codex' || providerId === 'cursor') {
    return providerId;
  }
  return null;
}

export function seatsForBindings(bindings: readonly { providerId: string }[]): SeatId[] {
  const seats: SeatId[] = [];
  for (const binding of bindings) {
    const seat = seatForProvider(binding.providerId);
    if (seat && !seats.includes(seat)) seats.push(seat);
  }
  return seats;
}

export function unknownSeatReading(seat: SeatId, note: string, httpStatus?: number): SeatReading {
  return {
    seat,
    limit_source: 'UNKNOWN',
    windows: [],
    seven_day: seat === 'cursor' ? 'NOT_APPLICABLE' : 'UNKNOWN',
    gate_windows: [...GATE_WINDOWS[seat]],
    note,
    probed_at: new Date().toISOString(),
    endpoint: ENDPOINTS[seat],
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
  };
}

function sevenDayFromWindows(seat: SeatId, windows: readonly SeatWindow[]): SevenDayReading {
  if (seat === 'cursor') return 'NOT_APPLICABLE';
  if (seat === 'claude') {
    const window = windows.find(w => w.name === 'seven_day');
    if (!window) return 'UNKNOWN';
    return {
      used_percent: window.used_percent,
      remaining_percent: window.remaining_percent,
      resets_at: window.resets_at,
    };
  }
  const window = windows.find(w => w.window_seconds === CODEX_SEVEN_DAY_SECONDS);
  if (!window) return 'UNKNOWN';
  return {
    used_percent: window.used_percent,
    remaining_percent: window.remaining_percent,
    resets_at: window.resets_at,
  };
}

function measuredReading(
  seat: SeatId,
  windows: SeatWindow[],
  extra: { plan?: string; allowed?: boolean; limit_reached?: boolean; credits?: SeatCredits },
  deps?: SeatReadDeps
): SeatReading {
  return {
    seat,
    limit_source: 'measured',
    ...(extra.plan !== undefined ? { plan: extra.plan } : {}),
    windows,
    seven_day: sevenDayFromWindows(seat, windows),
    gate_windows: [...GATE_WINDOWS[seat]],
    note: '',
    probed_at: new Date(nowMs(deps)).toISOString(),
    endpoint: ENDPOINTS[seat],
    ...(extra.allowed !== undefined ? { allowed: extra.allowed } : {}),
    ...(extra.limit_reached !== undefined ? { limit_reached: extra.limit_reached } : {}),
    ...(extra.credits !== undefined ? { credits: extra.credits } : {}),
  };
}

/** Parse the Codex usage endpoint's top-level `credits` object, else undefined. */
export function parseCodexCredits(raw: unknown): SeatCredits | undefined {
  if (!isRecord(raw) || typeof raw.has_credits !== 'boolean') return undefined;
  return {
    has_credits: raw.has_credits,
    unlimited: raw.unlimited === true,
    overage_limit_reached: raw.overage_limit_reached === true,
    ...(typeof raw.balance === 'string' ? { balance: raw.balance } : {}),
  };
}

/**
 * True when a measured codex seat bills purchased credits past its window
 * (has_credits true, overage not blocked, request still allowed). Such a seat
 * has headroom regardless of window percent (John Ranson, 2026-10-27).
 */
export function codexOnCredits(reading: SeatReading): boolean {
  return (
    reading.seat === 'codex' &&
    reading.credits?.has_credits === true &&
    !reading.credits.overage_limit_reached &&
    reading.allowed !== false
  );
}

function asResetsAt(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return 'UNKNOWN';
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function probeFetch(deps?: SeatReadDeps): typeof fetch {
  return deps?.fetch ?? fetch;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  deps?: SeatReadDeps
): Promise<
  { ok: true; status: number; body: unknown } | { ok: false; status: number; note: string }
> {
  const response = await probeFetch(deps)(url, {
    headers,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, note: `HTTP ${response.status}` };
  }
  try {
    const body: unknown = await response.json();
    return { ok: true, status: response.status, body };
  } catch {
    return { ok: false, status: response.status, note: 'non-JSON body' };
  }
}

async function probeClaude(deps?: SeatReadDeps): Promise<SeatReading> {
  const path =
    deps?.claudeCredentialsFile ??
    envOf(deps, 'FUELGLASS_CLAUDE_CREDENTIALS_FILE') ??
    join(homedir(), '.claude', '.credentials.json');
  const creds = await readJsonFile(path);
  const oauth = isRecord(creds) && isRecord(creds.claudeAiOauth) ? creds.claudeAiOauth : null;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
  if (!token) return unknownSeatReading('claude', 'no Claude Code OAuth token');
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt < nowMs(deps)) {
    return unknownSeatReading('claude', 'Claude token expired');
  }
  const plan =
    oauth && typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined;
  let result: Awaited<ReturnType<typeof fetchJson>>;
  try {
    result = await fetchJson(
      CLAUDE_ENDPOINT,
      {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_BETA,
        'Content-Type': 'application/json',
      },
      deps
    );
  } catch {
    return unknownSeatReading('claude', 'Claude limit probe failed');
  }
  if (!result.ok) {
    return unknownSeatReading(
      'claude',
      `Claude limit probe rejected (${result.note})`,
      result.status
    );
  }
  if (!isRecord(result.body)) {
    return unknownSeatReading('claude', 'unrecognized shape (top-level keys: )');
  }
  const windows: SeatWindow[] = [];
  for (const [name, value] of Object.entries(result.body)) {
    if (
      !isRecord(value) ||
      typeof value.utilization !== 'number' ||
      !Number.isFinite(value.utilization)
    ) {
      continue;
    }
    const used = clampPercent(value.utilization);
    windows.push({
      name,
      used_percent: round2(used),
      remaining_percent: round2(100 - used),
      resets_at: asResetsAt(value.resets_at),
    });
  }
  if (windows.length === 0) {
    const keys = Object.keys(result.body).join(', ');
    return unknownSeatReading('claude', `unrecognized shape (top-level keys: ${keys})`);
  }
  return measuredReading('claude', windows, { plan }, deps);
}

function codexWindow(name: string, raw: unknown): SeatWindow | null {
  if (!isRecord(raw) || typeof raw.used_percent !== 'number') return null;
  const used = raw.used_percent;
  const seconds = raw.limit_window_seconds;
  return {
    name,
    used_percent: used,
    remaining_percent: round2(100 - used),
    window_seconds: typeof seconds === 'number' ? seconds : 'UNKNOWN',
    resets_at: asResetsAt(raw.reset_at),
  };
}

async function probeCodex(deps?: SeatReadDeps): Promise<SeatReading> {
  const path =
    deps?.codexAuthFile ??
    envOf(deps, 'FUELGLASS_CODEX_AUTH_FILE') ??
    join(homedir(), '.codex', 'auth.json');
  const auth = await readJsonFile(path);
  const tokens = isRecord(auth) && isRecord(auth.tokens) ? auth.tokens : null;
  const token = tokens && typeof tokens.access_token === 'string' ? tokens.access_token : '';
  if (!token) return unknownSeatReading('codex', 'no Codex access token');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'fuelglass/0.1 (codex usage probe)',
  };
  if (typeof tokens?.account_id === 'string' && tokens.account_id.length > 0) {
    headers['chatgpt-account-id'] = tokens.account_id;
  }
  let result: Awaited<ReturnType<typeof fetchJson>>;
  try {
    result = await fetchJson(CODEX_ENDPOINT, headers, deps);
  } catch {
    return unknownSeatReading('codex', 'Codex limit probe failed');
  }
  if (!result.ok) {
    return unknownSeatReading(
      'codex',
      `Codex limit probe rejected (${result.note})`,
      result.status
    );
  }
  if (!isRecord(result.body) || !isRecord(result.body.rate_limit)) {
    return unknownSeatReading('codex', 'unrecognized shape');
  }
  const rate = result.body.rate_limit;
  const windows: SeatWindow[] = [];
  const primary = codexWindow('primary', rate.primary_window);
  if (primary) windows.push(primary);
  const secondary = codexWindow('secondary', rate.secondary_window);
  if (secondary) windows.push(secondary);
  if (windows.length === 0) return unknownSeatReading('codex', 'unrecognized shape');
  const plan = typeof result.body.plan_type === 'string' ? result.body.plan_type : undefined;
  return measuredReading(
    'codex',
    windows,
    {
      plan,
      allowed: rate.allowed === true,
      limit_reached: rate.limit_reached === true,
      credits: parseCodexCredits(result.body.credits),
    },
    deps
  );
}

function cursorCookie(token: string): { cookie: string } | { error: string } {
  if (/%3A%3A/i.test(token)) return { cookie: token };
  if (token.includes('::')) return { cookie: token.replace('::', '%3A%3A') };
  const payload = token.split('.')[1];
  if (!payload) return { error: 'unrecognized Cursor session token' };
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
    };
    const sub = typeof json.sub === 'string' ? json.sub : '';
    const userId = sub.replace(/^auth0\|/, '');
    if (!userId) return { error: 'no Cursor user id in session token' };
    return { cookie: `${userId}%3A%3A${token}` };
  } catch {
    return { error: 'unrecognized Cursor session token' };
  }
}

async function probeCursor(deps?: SeatReadDeps): Promise<SeatReading> {
  const raw = envOf(deps, 'FUELGLASS_CURSOR_SESSION_TOKEN');
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) {
    return unknownSeatReading('cursor', 'no Cursor session credential in this environment');
  }
  const cookie = cursorCookie(token);
  if ('error' in cookie) return unknownSeatReading('cursor', cookie.error);
  let result: Awaited<ReturnType<typeof fetchJson>>;
  try {
    result = await fetchJson(
      CURSOR_ENDPOINT,
      {
        Cookie: `${CURSOR_COOKIE}=${cookie.cookie}`,
        Accept: 'application/json',
      },
      deps
    );
  } catch {
    return unknownSeatReading('cursor', 'Cursor usage probe failed');
  }
  if (!result.ok) {
    return unknownSeatReading(
      'cursor',
      `Cursor usage authentication failed (${result.note})`,
      result.status
    );
  }
  if (!isRecord(result.body)) {
    return unknownSeatReading('cursor', 'unrecognized shape (top-level keys: )');
  }
  const individual = isRecord(result.body.individualUsage) ? result.body.individualUsage : null;
  const plan = individual && isRecord(individual.plan) ? individual.plan : null;
  const usedRaw = plan?.used;
  const limitRaw = plan?.limit;
  if (
    typeof usedRaw !== 'number' ||
    typeof limitRaw !== 'number' ||
    !Number.isFinite(usedRaw) ||
    !Number.isFinite(limitRaw) ||
    limitRaw <= 0
  ) {
    const keys = Object.keys(result.body).join(', ');
    return unknownSeatReading('cursor', `unrecognized shape (top-level keys: ${keys})`);
  }
  const used = clampPercent((usedRaw / limitRaw) * 100);
  const resets =
    typeof result.body.billingCycleEnd === 'string' ? result.body.billingCycleEnd : 'UNKNOWN';
  const planLabel =
    typeof result.body.membershipType === 'string' ? result.body.membershipType : undefined;
  return measuredReading(
    'cursor',
    [
      {
        name: 'monthly',
        used_percent: round2(used),
        remaining_percent: round2(100 - used),
        resets_at: resets,
      },
    ],
    { plan: planLabel },
    deps
  );
}

function pushedReadingAgeMinutes(observedAt: string, deps?: SeatReadDeps): number {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return Number.POSITIVE_INFINITY;
  return Math.floor((nowMs(deps) - observedMs) / 60_000);
}

function pushedReadingIsFresh(observedAt: string, deps?: SeatReadDeps): boolean {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return false;
  const maxAgeMs = resolvePushedReadingMaxAgeMinutes(deps) * 60_000;
  return nowMs(deps) - observedMs <= maxAgeMs;
}

function seatReadingFromPushed(row: PushedCursorReading, deps?: SeatReadDeps): SeatReading {
  if (!pushedReadingIsFresh(row.observed_at, deps)) {
    const ageMinutes = pushedReadingAgeMinutes(row.observed_at, deps);
    const ageLabel = Number.isFinite(ageMinutes) ? String(ageMinutes) : 'unknown';
    return {
      ...unknownSeatReading(
        'cursor',
        `reading_stale observed_at=${row.observed_at} age_minutes=${ageLabel}`
      ),
      reading_source: 'pushed',
      observed_at: row.observed_at,
    };
  }
  return {
    ...measuredReading(
      'cursor',
      [
        {
          name: 'monthly',
          used_percent: row.used_percent,
          remaining_percent: row.remaining_percent,
          resets_at: row.resets_at,
        },
      ],
      {},
      deps
    ),
    reading_source: 'pushed',
    observed_at: row.observed_at,
  };
}

async function loadProductionPushedReading(): Promise<PushedCursorReading | null> {
  return getLatestSeatUsageReading('cursor');
}

/**
 * Cursor prefers a desktop-pushed reading. A fresh row is measured and does
 * not probe. A stale row is UNKNOWN. No row falls through to the direct probe.
 * A loader failure logs once per call and falls through to the direct probe.
 */
async function cursorFromPushedReading(deps?: SeatReadDeps): Promise<SeatReading | null> {
  const loader = deps?.loadPushedReading ?? loadProductionPushedReading;
  let row: PushedCursorReading | null;
  try {
    row = await loader();
  } catch (err) {
    warnLog(
      { error: err instanceof Error ? err.message : String(err) },
      'fuelglass.pushed_reading_read_failed'
    );
    return null;
  }
  if (!row) return null;
  return seatReadingFromPushed(row, deps);
}

async function probeSeat(seat: SeatId, deps?: SeatReadDeps): Promise<SeatReading> {
  if (seat === 'claude') return probeClaude(deps);
  if (seat === 'codex') return probeCodex(deps);
  return probeCursor(deps);
}

/** Minutes a pushed cursor reading stays fresh. Blank env uses 30. Invalid env uses 30 and logs once. */
export function resolvePushedReadingMaxAgeMinutes(deps?: SeatReadDeps): number {
  const raw = envOf(deps, 'FUELGLASS_PUSHED_READING_MAX_AGE_MINUTES');
  if (raw === undefined || raw.trim() === '') return DEFAULT_PUSHED_READING_MAX_AGE_MINUTES;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  const valid =
    /^\d+$/.test(trimmed) &&
    Number.isInteger(parsed) &&
    parsed >= MIN_PUSHED_READING_MAX_AGE_MINUTES &&
    parsed <= MAX_PUSHED_READING_MAX_AGE_MINUTES;
  if (!valid) {
    if (!invalidPushedMaxAgeLogged) {
      invalidPushedMaxAgeLogged = true;
      warnLog({ raw }, 'fuelglass.pushed_reading_max_age_env_invalid');
    }
    return DEFAULT_PUSHED_READING_MAX_AGE_MINUTES;
  }
  return parsed;
}

export async function readSeat(seat: SeatId, deps?: SeatReadDeps): Promise<SeatReading> {
  // A pushed Cursor row is reloaded on every decision so a newer or newly
  // stale reading is honored inside the 55s probe-cache window. It is not
  // written into the cache; only a direct probe (no pushed row) is.
  if (seat === 'cursor') {
    const pushed = await cursorFromPushedReading(deps);
    if (pushed) return pushed;
  }
  const now = nowMs(deps);
  const hit = cache.get(seat);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.reading;
  const pending = inflight.get(seat);
  if (pending) return pending;
  const started = now;
  const promise = probeSeat(seat, deps)
    .catch(() => unknownSeatReading(seat, 'seat probe failed'))
    .then(reading => {
      cache.set(seat, { at: started, reading });
      inflight.delete(seat);
      return reading;
    });
  inflight.set(seat, promise);
  return promise;
}

async function defaultSeatUsageReader(
  seats: readonly SeatId[],
  deps?: SeatReadDeps
): Promise<Partial<Record<SeatId, SeatReading>>> {
  const out: Partial<Record<SeatId, SeatReading>> = {};
  await Promise.all(
    seats.map(async seat => {
      out[seat] = await readSeat(seat, deps);
    })
  );
  return out;
}

export function getSeatUsageReader(): SeatUsageReader {
  return readerOverride ?? defaultSeatUsageReader;
}

export function setSeatUsageReaderForTests(reader: SeatUsageReader | null): void {
  readerOverride = reader;
}

export function setSeatUsageLogForTests(log: WarnLog | null): void {
  warnLog = log ?? defaultWarn;
}

export async function readAllSeats(deps?: SeatReadDeps): Promise<Record<SeatId, SeatReading>> {
  const partial = await getSeatUsageReader()([...SEAT_IDS], deps);
  const out = {} as Record<SeatId, SeatReading>;
  for (const seat of SEAT_IDS) {
    out[seat] = partial[seat] ?? unknownSeatReading(seat, 'seat reading missing');
  }
  return out;
}

export function setSeatAlertSendForTests(send: SeatAlertSend | null): void {
  alertSend = send ?? defaultAlertSend;
}

/** Drop one seat's cached reading and in-flight probe. Leaves alerts and cutoff alone. */
export function invalidateSeatUsageCache(seat: SeatId): void {
  cache.delete(seat);
  inflight.delete(seat);
}

export function resetSeatUsageCacheForTests(): void {
  cache.clear();
  inflight.clear();
  unknownAlertBucket.clear();
  cutoffOverride = null;
  invalidCutoffLogged = false;
  invalidPushedMaxAgeLogged = false;
  readerOverride = null;
  warnLog = defaultWarn;
  alertSend = defaultAlertSend;
}

interface SeatOverCutoff {
  window: string;
  usedPercent: number;
}

/** The first gate window at or over the cutoff for a measured seat, else null. */
function seatOverCutoff(
  seat: SeatId,
  reading: SeatReading,
  cutoffPercent: number
): SeatOverCutoff | null {
  const gateNames = GATE_WINDOWS[seat];
  for (const name of gateNames) {
    const window = reading.windows.find(w => w.name === name);
    if (window && window.used_percent >= cutoffPercent) {
      return { window: name, usedPercent: window.used_percent };
    }
  }
  if (seat === 'codex' && reading.limit_reached === true) {
    const window = reading.windows.find(w => gateNames.includes(w.name)) ?? reading.windows[0];
    return { window: window?.name ?? 'primary', usedPercent: window?.used_percent ?? 0 };
  }
  return null;
}

/**
 * Split a lane's bindings into the lane seat (seat of the workflow-level
 * provider the run was fired on) and node seats (seats bound by individual
 * nodes, keyed by seat, excluding the lane seat).
 */
export function classifySeatGateScope(scope: SeatGateScope): {
  laneSeat: SeatId | null;
  nodeSeats: Partial<Record<SeatId, SeatGateNodeBinding[]>>;
} {
  const laneSeat = seatForProvider(scope.laneProvider);
  const nodeSeats: Partial<Record<SeatId, SeatGateNodeBinding[]>> = {};
  for (const node of scope.nodes) {
    const seat = seatForProvider(node.providerId);
    if (seat === null || seat === laneSeat) continue;
    (nodeSeats[seat] ??= []).push(node);
  }
  return { laneSeat, nodeSeats };
}

/**
 * Seats a scoped gate needs read: the bound seats, the lane seat, and the
 * seat of every declared failover target (to judge failover headroom).
 */
export function seatsForGateScope(
  bindings: readonly { providerId: string }[],
  scope: SeatGateScope
): SeatId[] {
  const seats = seatsForBindings(bindings);
  const extra = [scope.laneProvider, ...scope.nodes.map(node => node.failoverProvider ?? '')];
  for (const providerId of extra) {
    const seat = seatForProvider(providerId);
    if (seat && !seats.includes(seat)) seats.push(seat);
  }
  return seats;
}

export function decideSeatGate(
  bindings: readonly { providerId: string }[],
  readings: Partial<Record<SeatId, SeatReading>>,
  cutoffPercent: number,
  scope?: SeatGateScope
): SeatGateDecision {
  if (scope) return decideScopedSeatGate(bindings, readings, cutoffPercent, scope);
  // Collect every unknown seat and the first refusal in one pass over ALL
  // bound seats, independently of each other. A seat that trips the cutoff
  // must not swallow the UNKNOWN diagnostics for other bound seats -- both
  // are reported: the run still refuses (that semantics is unchanged), but
  // the unknown-seat log line and operator alert still fire for every seat
  // that could not be measured, refusal or not.
  const unknownSeats: SeatId[] = [];
  const onCredits: string[] = [];
  let refusal: SeatGateRefuse | null = null;
  for (const seat of seatsForBindings(bindings)) {
    const reading = readings[seat];
    if (reading?.limit_source !== 'measured') {
      unknownSeats.push(seat);
      continue;
    }
    if (refusal) continue;
    const over = seatOverCutoff(seat, reading, cutoffPercent);
    if (over && codexOnCredits(reading)) {
      onCredits.push(`${seat}:on_credits`);
      continue;
    }
    if (over) {
      refusal = {
        refused: true,
        seat,
        window: over.window,
        usedPercent: over.usedPercent,
        cutoffPercent,
        unknownSeats: [],
      };
    }
  }
  const credits = onCredits.length > 0 ? { onCredits } : {};
  if (refusal) return { ...refusal, unknownSeats, ...credits };
  return { refused: false, unknownSeats, ...credits };
}

/**
 * Lane-scoped gate (WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01). The
 * lane's own seat over the cutoff refuses (role=lane). A seat bound only by
 * nodes over the cutoff refuses (role=node) unless EVERY node on it has an
 * eligible failover target whose seat is not measured at or over the cutoff;
 * then the run proceeds and the seat is reported in degradedSeats. UNKNOWN
 * never refuses on its own.
 */
function decideScopedSeatGate(
  bindings: readonly { providerId: string }[],
  readings: Partial<Record<SeatId, SeatReading>>,
  cutoffPercent: number,
  scope: SeatGateScope
): SeatGateDecision {
  const { laneSeat, nodeSeats } = classifySeatGateScope(scope);
  const bound = seatsForBindings(bindings);
  const seats: SeatId[] = laneSeat ? [laneSeat, ...bound.filter(s => s !== laneSeat)] : bound;
  const unknownSeats: SeatId[] = [];
  const degradedSeats: SeatGateDegradedSeat[] = [];
  const onCredits: string[] = [];
  let refusal: SeatGateRefuse | null = null;

  const failoverHasHeadroom = (fromSeat: SeatId, failoverProvider: string): boolean => {
    const target = seatForProvider(failoverProvider);
    if (target === null) return true;
    if (target === fromSeat) return false;
    const reading = readings[target];
    if (reading?.limit_source !== 'measured') return true;
    if (codexOnCredits(reading)) return true;
    return seatOverCutoff(target, reading, cutoffPercent) === null;
  };

  for (const seat of seats) {
    const reading = readings[seat];
    if (reading?.limit_source !== 'measured') {
      unknownSeats.push(seat);
      continue;
    }
    if (refusal) continue;
    const over = seatOverCutoff(seat, reading, cutoffPercent);
    if (!over) continue;
    if (codexOnCredits(reading)) {
      onCredits.push(`${seat}:on_credits`);
      continue;
    }
    const base = {
      refused: true as const,
      seat,
      window: over.window,
      usedPercent: over.usedPercent,
      cutoffPercent,
      unknownSeats: [],
    };
    if (seat === laneSeat) {
      refusal = { ...base, role: 'lane' };
      continue;
    }
    const nodes = nodeSeats[seat] ?? [];
    const covered =
      nodes.length > 0 &&
      nodes.every(
        node =>
          node.failoverProvider !== undefined && failoverHasHeadroom(seat, node.failoverProvider)
      );
    if (!covered) {
      refusal = { ...base, role: 'node' };
      continue;
    }
    degradedSeats.push({
      seat,
      window: over.window,
      usedPercent: over.usedPercent,
      cutoffPercent,
      nodeIds: nodes.map(node => node.nodeId),
      failoverProviders: [...new Set(nodes.map(node => node.failoverProvider ?? ''))],
    });
  }
  const credits = onCredits.length > 0 ? { onCredits } : {};
  if (refusal) return { ...refusal, unknownSeats, ...credits };
  return { refused: false, unknownSeats, degradedSeats, ...credits };
}

/** True when percent is a finite number inside the accepted 1-95 range. */
export function isValidSeatCutoff(percent: number): boolean {
  return (
    Number.isFinite(percent) &&
    percent >= MIN_SEAT_CUTOFF_PERCENT &&
    percent <= MAX_SEAT_CUTOFF_PERCENT
  );
}

function cutoffFromEnv(): { percent: number; valid: boolean; raw: string | undefined } {
  const raw = process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  if (raw === undefined || raw.trim() === '') {
    return { percent: DEFAULT_SEAT_CUTOFF_PERCENT, valid: true, raw };
  }
  const parsed = Number(raw);
  if (!isValidSeatCutoff(parsed)) {
    return { percent: DEFAULT_SEAT_CUTOFF_PERCENT, valid: false, raw };
  }
  return { percent: parsed, valid: true, raw };
}

export function getSeatCutoff(): SeatCutoff {
  if (cutoffOverride !== null) return { percent: cutoffOverride, source: 'operator' };
  const fromEnv = cutoffFromEnv();
  if (!fromEnv.valid && !invalidCutoffLogged) {
    invalidCutoffLogged = true;
    warnLog({ raw: fromEnv.raw ?? '' }, 'fuelglass.seat_cutoff_env_invalid');
  }
  if (!fromEnv.valid) return { percent: DEFAULT_SEAT_CUTOFF_PERCENT, source: 'default' };
  if (fromEnv.raw === undefined || fromEnv.raw.trim() === '') {
    return { percent: DEFAULT_SEAT_CUTOFF_PERCENT, source: 'default' };
  }
  return { percent: fromEnv.percent, source: 'env' };
}

export function setSeatCutoffOverride(percent: number | null): void {
  if (percent === null) {
    cutoffOverride = null;
    return;
  }
  if (!isValidSeatCutoff(percent)) {
    throw new Error(
      `${SEAT_CUTOFF_OUT_OF_RANGE}: seat cutoff percent must be between ${String(MIN_SEAT_CUTOFF_PERCENT)} and ${String(MAX_SEAT_CUTOFF_PERCENT)}`
    );
  }
  cutoffOverride = percent;
}

export async function loadPersistedSeatCutoff(): Promise<{ value: string; setAt: string } | null> {
  const row = await getOperatorSetting(FUELGLASS_SEAT_CUTOFF_SETTING_KEY);
  if (!row) return null;
  return { value: row.setting_value, setAt: row.updated_at };
}

/**
 * Load a persisted operator cutoff into memory. Does not catch: a loader
 * failure rejects so startServer can log it and continue.
 */
export async function restoreSeatCutoffOverride(
  loader: () => Promise<{ value: string; setAt: string } | null>
): Promise<void> {
  const loaded = await loader();
  if (loaded === null) return;
  const n = Number(loaded.value);
  if (!isValidSeatCutoff(n)) {
    warnLog({ raw: loaded.value }, 'fuelglass.seat_cutoff_persisted_invalid');
    return;
  }
  warnLog({ percent: n, setAt: loaded.setAt }, 'fuelglass.seat_cutoff_override_restored');
  setSeatCutoffOverride(n);
}

/** UTC hour bucket, e.g. 2026-09-24T10. */
function hourBucketLabel(bucket: number): string {
  return new Date(bucket * UNKNOWN_ALERT_WINDOW_MS).toISOString().slice(0, 13);
}

export interface SeatUnknownAlertContext {
  workflowName?: string;
  workflowRunId?: string;
  now?: number;
}

/**
 * Tell the operator that the gate could not measure a seat. The run is NOT
 * stopped (a broken probe must not stop all work). At most one alert per seat
 * per UTC hour: an in-memory marker, plus a Dispatch idempotency key derived
 * from the seat and the hour bucket so a restart inside the same hour does not
 * send a second one. Never throws. Returns true when a message was enqueued.
 */
export async function alertUnknownSeat(
  seat: SeatId,
  note: string,
  context: SeatUnknownAlertContext = {}
): Promise<boolean> {
  const bucket = Math.floor((context.now ?? Date.now()) / UNKNOWN_ALERT_WINDOW_MS);
  if (unknownAlertBucket.get(seat) === bucket) return false;
  unknownAlertBucket.set(seat, bucket);
  const hour = hourBucketLabel(bucket);
  const key = `fuelglass-seat-unknown:${seat}:${hour}`;
  const runLine =
    context.workflowRunId !== undefined
      ? `\nFirst affected run: ${context.workflowName ?? 'unknown workflow'} (${context.workflowRunId}).`
      : '';
  const body =
    `Fuelglass seat gate could not measure seat ${seat}\n` +
    `The seat gate could not measure the ${seat} seat, so runs on it are proceeding without the usage cutoff.\n` +
    `Note: ${note || 'UNKNOWN'}\n` +
    `Hour (UTC): ${hour}. At most one alert per seat per hour.${runLine}\n` +
    'Check: GET /api/fuelglass/seats';
  try {
    await alertSend(
      { kind: 'system', sender: 'dispatch' },
      {
        correlation_id: key,
        idempotency_key: key,
        task_type: 'agent_message',
        recipient: 'operator',
        priority: 'normal',
        body,
      }
    );
    return true;
  } catch (err) {
    // Clear the marker so the next unmeasured run retries the alert.
    unknownAlertBucket.delete(seat);
    warnLog(
      { seat, error: err instanceof Error ? err.message : String(err) },
      'fuelglass.seat_unknown_alert_failed'
    );
    return false;
  }
}
