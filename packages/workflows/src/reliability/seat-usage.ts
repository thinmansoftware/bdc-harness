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

export const SEAT_IDS = ['claude', 'codex', 'cursor'] as const;
export type SeatId = (typeof SEAT_IDS)[number];

/** Default cutoff (John Ranson, 2026-09-24; supersedes the M-171 default of 100). */
export const DEFAULT_SEAT_CUTOFF_PERCENT = 90;
/** Lowest accepted cutoff. */
export const MIN_SEAT_CUTOFF_PERCENT = 1;
/** Highest accepted cutoff. Anything higher would switch the gate off in effect. */
export const MAX_SEAT_CUTOFF_PERCENT = 95;
export const SEAT_CUTOFF_OUT_OF_RANGE = 'seat_cutoff_out_of_range';

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
}

export interface SeatGateAllow {
  refused: false;
  unknownSeats: SeatId[];
}
export interface SeatGateRefuse {
  refused: true;
  seat: SeatId;
  window: string;
  usedPercent: number;
  cutoffPercent: number;
}
export type SeatGateDecision = SeatGateAllow | SeatGateRefuse;

export interface SeatCutoff {
  percent: number;
  source: 'operator' | 'env' | 'default';
}

export interface SeatReadDeps {
  fetch?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  claudeCredentialsFile?: string;
  codexAuthFile?: string;
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
  extra: { plan?: string; allowed?: boolean; limit_reached?: boolean },
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
  };
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

async function probeSeat(seat: SeatId, deps?: SeatReadDeps): Promise<SeatReading> {
  if (seat === 'claude') return probeClaude(deps);
  if (seat === 'codex') return probeCodex(deps);
  return probeCursor(deps);
}

export async function readSeat(seat: SeatId, deps?: SeatReadDeps): Promise<SeatReading> {
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

export function resetSeatUsageCacheForTests(): void {
  cache.clear();
  inflight.clear();
  unknownAlertBucket.clear();
  cutoffOverride = null;
  invalidCutoffLogged = false;
  readerOverride = null;
  warnLog = defaultWarn;
  alertSend = defaultAlertSend;
}

export function decideSeatGate(
  bindings: readonly { providerId: string }[],
  readings: Partial<Record<SeatId, SeatReading>>,
  cutoffPercent: number
): SeatGateDecision {
  const unknownSeats: SeatId[] = [];
  for (const seat of seatsForBindings(bindings)) {
    const reading = readings[seat];
    if (reading?.limit_source !== 'measured') {
      unknownSeats.push(seat);
      continue;
    }
    const gateNames = GATE_WINDOWS[seat];
    for (const name of gateNames) {
      const window = reading.windows.find(w => w.name === name);
      if (window && window.used_percent >= cutoffPercent) {
        return {
          refused: true,
          seat,
          window: name,
          usedPercent: window.used_percent,
          cutoffPercent,
        };
      }
    }
    if (seat === 'codex' && reading.limit_reached === true) {
      const window = reading.windows.find(w => gateNames.includes(w.name)) ?? reading.windows[0];
      return {
        refused: true,
        seat,
        window: window?.name ?? 'primary',
        usedPercent: window?.used_percent ?? 0,
        cutoffPercent,
      };
    }
  }
  return { refused: false, unknownSeats };
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
