/**
 * The approval hand-off rule, shared by the cauldron-fire consumer (live-run
 * check, cascade poller hook) and the shared WO claim reader (wo-claim.ts), so
 * claim release and reconcile decide hand-off from the SAME latest decisive
 * events and the SAME bounded window (WO-HARNESS-T3-COMMAND-CONSUMER-01).
 */

/** A5.9: an approval hand-off `failed` is transitional only this long. */
const DEFAULT_APPROVAL_HANDOFF_S = 120;

/**
 * Parse a stored timestamp as UTC. SQLite `datetime('now')` text
 * ('YYYY-MM-DD HH:MM:SS', no zone) is UTC (A5.10).
 */
export function parseUtcTimestamp(value: string | Date | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (!value) return Number.NaN;
  const text = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(text);
}

/**
 * A2.1 item 5: a `failed` run whose most recent decisive event is
 * approval_received (no later *_failed event) is the approval's hand-off to its
 * resume, not a terminal failure. Passed to runCascade so the background
 * cascade keeps polling instead of recording a failure or climbing a rung.
 */
export function isApprovalHandOff(
  detail: {
    run: { status: string };
    events?: { event_type: string; created_at?: string | null }[];
  },
  bound?: { nowMs: number; maxAgeS: number }
): boolean {
  if (detail.run.status !== 'failed') return false;
  const events = detail.events ?? [];
  let lastApproval = -1;
  events.forEach((event, index) => {
    if (event.event_type === 'approval_received') lastApproval = index;
  });
  if (lastApproval < 0) return false;
  if (events.slice(lastApproval + 1).some(event => event.event_type.endsWith('_failed'))) {
    return false;
  }
  if (!bound) return true;
  // A5.9: transitional only within the bound -- a resume that never happens
  // must not be polled as live until the 4h ceiling.
  const approvedMs = parseUtcTimestamp(events[lastApproval]?.created_at ?? null);
  return Number.isFinite(approvedMs) && bound.nowMs - approvedMs <= bound.maxAgeS * 1000;
}

/** A5.9 bound from env. */
export function approvalHandOffBoundS(env: Record<string, string | undefined>): number {
  const raw = Number(env.T3_APPROVAL_HANDOFF_S);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_HANDOFF_S;
}
