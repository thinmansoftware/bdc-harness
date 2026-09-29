/**
 * Match an in-flight Cauldron run to a WO id so the merge bridge can defer a
 * merge while the run that produces the PR is still executing (bdc-harness
 * #1046, run 8ab3032a: a repair-target PR was merged mid-run, then the run
 * failed "out of scope" after its own PR had already landed).
 *
 * A run's WO id lives on the first `WO_ID=<id>` line of its user_message (e.g.
 * "WO_ID=WO-SHOPOPS-STAGING-REPLAY-TENANT-SCOPE-01 --project shopops ..."). The
 * match is exact on the WO id token: a prose mention of the id elsewhere in the
 * message does not count, and no prefix match is allowed (WO-A-0 must not match
 * WO-A-01, WO-A-01 must not match WO-A-011).
 */

const WO_ID_LINE_PATTERN = /^WO_ID=(\S+)/;

/**
 * Parse the WO id from the first `WO_ID=<id>` line of a run's user_message.
 * Returns null when no line begins with the `WO_ID=` marker (a prose mention of
 * a WO id is deliberately NOT parsed).
 */
export function userMessageWoId(userMessage: string): string | null {
  for (const line of userMessage.split(/\r?\n/)) {
    const match = WO_ID_LINE_PATTERN.exec(line.trim());
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * True only when some ACTIVE run's user_message carries a WO id that exactly
 * equals woId. `list` yields the user_message of every active run (injected so
 * the matching logic stays pure and testable without a live database).
 */
export async function hasActiveRunForWo(
  woId: string,
  list: () => Promise<string[]>
): Promise<boolean> {
  const messages = await list();
  return messages.some(message => userMessageWoId(message) === woId);
}
