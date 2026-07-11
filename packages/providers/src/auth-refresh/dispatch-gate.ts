import { createLogger } from '@archon/paths';
import { softRefreshCodex } from '../codex/soft-refresh.js';
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
  const before = readCodexFreshness(filePath);
  if (before.freshExpiresAt !== undefined) {
    getLog().debug(
      { fresh: true, freshExpiresAtISO: new Date(before.freshExpiresAt).toISOString() },
      'codex_dispatch_gate_fresh'
    );
    return { fresh: true, reason: 'fresh' };
  }

  const reason = reasonForStale(before.hasCreds, before.hasRefreshToken);
  getLog().warn({ fresh: false, reason }, 'codex_dispatch_gate_soft_refresh_attempt');

  const advanced = await softRefreshCodex();
  const after = readCodexFreshness(filePath);
  if (advanced && after.freshExpiresAt !== undefined) {
    getLog().info(
      { fresh: true, freshExpiresAtISO: new Date(after.freshExpiresAt).toISOString() },
      'codex_dispatch_gate_refreshed'
    );
    return { fresh: true, reason: 'fresh' };
  }

  const postReason = reasonForStale(after.hasCreds, after.hasRefreshToken);
  getLog().error(
    { fresh: false, reason: postReason, softRefreshAdvanced: advanced },
    'codex_dispatch_gate_blocked'
  );
  return { fresh: false, reason: postReason };
}
