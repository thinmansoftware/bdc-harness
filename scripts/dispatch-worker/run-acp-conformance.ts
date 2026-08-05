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
 *   1. A >= 60KB dispatch round-trips IN FULL and is receipted -- proven by a
 *      run-unique token placed at the tail of the payload coming back in the
 *      receipt, not merely by the payload being large.
 *   2. Cancel mid-generation stops work, a live process tree is observed, and
 *      no orphan descendants survive the kill.
 *   3. The seat's OWN failure leg is marked failed with a reason inside a
 *      budget derived from its timeouts -- never stuck queued.
 *   4. Every run above has a durable receipt matching reality.
 *
 * WHAT THIS DOES NOT DO:
 *   - It does NOT flip any seat live. Adding grok-acp to capabilities.providers
 *     in config.local.json is a SEPARATE operator edit, done only after all four
 *     tests are green here and recorded. Rollback is removing it from that list.
 *   - It CANNOT run in CI or the Cauldron container: there is no grok binary and
 *     no cached credential there. CI proves the harness itself against stub
 *     seats (acp/conformance.test.ts); this proves the real leg.
 *   - It will NOT invent a failure leg for you. There is deliberately no
 *     fallback to a guaranteed-missing binary: that would only prove the
 *     runtime reports a spawn error, never that THIS seat fails honestly when
 *     its auth expires or its agent dies mid-run. You must declare --failure.
 *
 * Run with:
 *   bun run scripts/dispatch-worker/run-acp-conformance.ts <seat-id> --failure=<mode>
 *
 * Failure modes (pick the one you can actually stage):
 *   --failure=auth
 *       Same seat binary and args, unchanged. Invalidate or expire the seat's
 *       cached credential FIRST (out of band), so `authenticate` genuinely
 *       fails. This is the Gate B path on the real leg.
 *   --failure=args:<space-separated args>
 *       Same seat binary, these replacement args, chosen so the real agent dies
 *       or hangs mid-run (for example a subcommand it will reject).
 *   --failure=seat:<other-seat-id>
 *       Use another configured ACP seat as the failure leg.
 *
 * Examples:
 *   bun run scripts/dispatch-worker/run-acp-conformance.ts grok-acp --failure=auth
 *   bun run scripts/dispatch-worker/run-acp-conformance.ts grok-acp --failure=args:agent-bogus-subcommand
 */
import { runConformanceMatrix, type SeatUnderTest } from './acp/conformance';
import { defaultAgentConfigs, type AgentConfig } from './adapters';

const USAGE = [
  'Usage:',
  '  bun run scripts/dispatch-worker/run-acp-conformance.ts <seat-id> --failure=<mode>',
  '',
  'Failure modes (required -- the harness will not fabricate one):',
  '  --failure=auth                  same seat, credential invalidated out of band (Gate B)',
  '  --failure=args:<args>           same binary, replacement args that make the leg die/hang',
  '  --failure=seat:<other-seat-id>  another configured ACP seat as the failure leg',
].join('\n');

function fail(message: string): never {
  console.error(message);
  console.error(`\n${USAGE}`);
  process.exit(2);
}

/**
 * Resolves the operator-declared failure leg. Returns a config or exits; it
 * never silently degrades to a substitute binary.
 */
function resolveFailureConfig(spec: string | undefined, seatConfig: AgentConfig): AgentConfig {
  if (!spec) {
    fail(
      'Missing --failure=<mode>. The forced-failure test must exercise THIS seat\n' +
        'failing for a real reason (expired auth, or an agent that dies or hangs\n' +
        'mid-run). Substituting a missing binary would only prove that the runtime\n' +
        'reports a spawn error, so it is no longer accepted.'
    );
  }
  if (spec === 'auth') {
    // Unchanged seat config: the operator has invalidated the credential, so
    // the real `authenticate` RPC is what fails.
    return seatConfig;
  }
  if (spec.startsWith('args:')) {
    const args = spec.slice('args:'.length).trim().split(/\s+/).filter(Boolean);
    if (args.length === 0) fail('--failure=args: requires at least one argument.');
    return { ...seatConfig, args };
  }
  if (spec.startsWith('seat:')) {
    const otherId = spec.slice('seat:'.length).trim();
    const other = defaultAgentConfigs[otherId];
    if (!other) {
      fail(
        `Unknown failure seat '${otherId}'. Known seats: ${Object.keys(defaultAgentConfigs).join(', ')}`
      );
    }
    if (other.kind !== 'acp') fail(`Failure seat '${otherId}' is not an ACP seat.`);
    return other;
  }
  return fail(`Unrecognized --failure mode '${spec}'.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seatId = args.find(arg => !arg.startsWith('--')) ?? 'grok-acp';
  const failureSpec = args.find(arg => arg.startsWith('--failure='))?.slice('--failure='.length);

  const config = defaultAgentConfigs[seatId];
  if (!config) {
    fail(`Unknown seat '${seatId}'. Known seats: ${Object.keys(defaultAgentConfigs).join(', ')}`);
  }
  if (config.kind !== 'acp') {
    fail(`Seat '${seatId}' is not an ACP seat (kind=${config.kind ?? 'prompt'}).`);
  }

  const failureConfig = resolveFailureConfig(failureSpec, config);

  const seat: SeatUnderTest = { id: seatId, config, failureConfig, cwd: process.cwd() };

  console.log(`\n=== ACP conformance matrix: ${seatId} (real binary) ===`);
  console.log(`failure leg: --failure=${failureSpec}\n`);
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
