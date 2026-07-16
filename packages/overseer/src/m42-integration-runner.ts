/**
 * M-42 Slice 8 in-container integration runner.
 *
 * Invoked inside archon-m42-staging from the production image's copied
 * packages/overseer source tree. Host working-tree execution does not count
 * as candidate proof.
 */

import {
  assertOverseerDefaultOff,
  runIntegratedSuccessChain,
  runOverseerAdversarialMatrix,
} from './integration-scenarios';
import { createRealCallTracker } from './integration-fixtures';

async function main(): Promise<number> {
  const tracker = createRealCallTracker();
  const deps = {
    adapter_mode: 'fake' as const,
    call_tracker: tracker,
  };

  const chain = await runIntegratedSuccessChain(deps);
  const matrix = await runOverseerAdversarialMatrix(deps);
  const def = assertOverseerDefaultOff({
    capabilities: {
      escalation: false,
      repair: false,
      branch: false,
      lifecycle: false,
      merge: false,
    },
    emergency_stop: true,
    circuits: {
      escalation: 'closed',
      repair: 'closed',
      branch: 'closed',
      lifecycle: 'closed',
      merge: 'closed',
    },
  });

  const observedRealCalls = tracker.getRealCallCount();
  if (
    !chain.ok ||
    !matrix.ok ||
    !def.ok ||
    observedRealCalls !== 0 ||
    chain.real_call_count !== 0 ||
    matrix.real_call_count !== 0
  ) {
    console.error(
      JSON.stringify({
        ok: false,
        chain_ok: chain.ok,
        matrix_ok: matrix.ok,
        default_off_ok: def.ok,
        real_call_count: observedRealCalls,
        reasons: def.reasons,
      })
    );
    return 1;
  }

  const receiptCount =
    chain.receipts.length + matrix.results.filter(r => r.scenario_id === 'success').length;
  process.stdout.write(
    JSON.stringify({
      schema_version: 'm42-integration-runner-receipt-v1',
      ok: true,
      receipt_count: receiptCount,
      real_call_count: observedRealCalls,
      disabled_capabilities: def.disabled_capabilities,
      emergency_stop: def.emergency_stop,
      adapter_mode: 'fake',
      success_ok: chain.ok,
      matrix_ok: matrix.ok,
      ordered_capabilities: chain.receipts.map(r => r.capability),
      observed_call_reasons: tracker.reasons,
    })
  );
  return 0;
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
