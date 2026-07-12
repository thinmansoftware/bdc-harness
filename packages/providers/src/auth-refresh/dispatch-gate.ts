import { createLogger } from '@archon/paths';
import { getCodexCredentialsPath, readCodexFreshness } from './preflight.js';

export interface DispatchGateResult {
  fresh: boolean;
  reason?: 'fresh' | 'stale' | 'missing_creds' | 'missing_refresh_token';
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.auth-refresh.dispatch-gate');
  return cachedLog;
}

function reasonForStale(hasCreds: boolean, hasRefreshToken: boolean): DispatchGateResult['reason'] {
  if (!hasCreds) return 'missing_creds';
  if (!hasRefreshToken) return 'missing_refresh_token';
  return 'stale';
}

export async function checkCodexDispatchGate(): Promise<DispatchGateResult> {
  const filePath = getCodexCredentialsPath();
  const freshness = readCodexFreshness(filePath);
  if (freshness.freshExpiresAt !== undefined) {
    getLog().debug(
      { fresh: true, freshExpiresAtISO: new Date(freshness.freshExpiresAt).toISOString() },
      'codex_dispatch_gate_fresh'
    );
    return { fresh: true, reason: 'fresh' };
  }

  const reason = reasonForStale(freshness.hasCreds, freshness.hasRefreshToken);
  getLog().error({ fresh: false, reason }, 'codex_dispatch_gate_blocked');
  return { fresh: false, reason };
}
