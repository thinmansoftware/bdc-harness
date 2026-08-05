/**
 * Operator script: run the ACP evidence-contract conformance matrix against a
 * REAL configured seat (default grok-acp) on the operator's host.
 *
 * WO-HARNESS-GROK-ACP-PROMOTION-01 (M-126 disposition T5). This is the artifact
 * the operator runs on the Windows host for the real-binary four-test matrix.
 * It reuses the SAME runConformanceMatrix that acp/conformance.test.ts exercises
 * against stub seats in CI -- there is no second, real-binary-only code path.
 *
 * WHAT THIS PROVES (when run against real grok 0.2.118 with a live cached_token):
 *   1. A >= 60KB dispatch round-trips and is receipted.
 *   2. Cancel mid-generation stops work with no orphan descendants.
 *   3. A forced failure (a deliberately unresolvable invocation) is marked
 *      failed with a reason inside the timeout -- never stuck queued.
 *   4. Every run above has a durable receipt matching reality.
 *
 * WHAT THIS DOES NOT DO:
 *   - It does NOT flip any seat live. Adding grok-acp to capabilities.providers
 *     in config.local.json is a SEPARATE operator edit, done only after all four
 *     tests are green here and recorded. Rollback is removing it from that list.
 *   - It CANNOT run in CI or the Cauldron container: there is no grok binary and
 *     no cached credential there. CI proves the harness itself against stub
 *     seats (acp/conformance.test.ts); this proves the real leg.
 *   - The forced-failure test uses a guaranteed-missing binary to prove the
 *     fail-loud path universally. To exercise a real cached_token expiry against
 *     grok, invalidate the cached token before running; Gate B's stub proof
 *     (auth-reject) is what CI covers.
 *
 * Run with:
 *   bun run scripts/dispatch-worker/run-acp-conformance.ts [seat-id]
 * e.g.:
 *   bun run scripts/dispatch-worker/run-acp-conformance.ts grok-acp
 */
import { runConformanceMatrix, type SeatUnderTest } from './acp/conformance';
import { defaultAgentConfigs } from './adapters';

async function main(): Promise<void> {
  const seatId = process.argv[2] ?? 'grok-acp';
  const config = defaultAgentConfigs[seatId];
  if (!config) {
    console.error(
      `Unknown seat '${seatId}'. Known seats: ${Object.keys(defaultAgentConfigs).join(', ')}`
    );
    process.exit(2);
  }
  if (config.kind !== 'acp') {
    console.error(`Seat '${seatId}' is not an ACP seat (kind=${config.kind ?? 'prompt'}).`);
    process.exit(2);
  }

  const seat: SeatUnderTest = { id: seatId, config, cwd: process.cwd() };

  console.log(`\n=== ACP conformance matrix: ${seatId} (real binary) ===\n`);
  const report = await runConformanceMatrix(seat, {});

  const rows = [report.roundTrip, report.cancel, report.forcedFailure, report.receiptAudit];
  for (const row of rows) {
    console.log(`[${row.pass ? 'PASS' : 'FAIL'}] ${row.name}`);
    console.log(`        evidence: ${JSON.stringify(row.evidence)}`);
    if (row.detail) console.log(`        detail: ${row.detail}`);
  }

  console.log(`\nallGreen: ${report.allGreen}`);
  if (report.allGreen) {
    console.log(
      `\nAll four green. '${seatId}' MAY be added to capabilities.providers in ` +
        'config.local.json (a separate operator step). Rollback is removing it from that list.'
    );
  } else {
    console.log(
      `\nNOT all green. '${seatId}' stays dark -- do NOT add it to capabilities.providers.`
    );
  }

  process.exit(report.allGreen ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
