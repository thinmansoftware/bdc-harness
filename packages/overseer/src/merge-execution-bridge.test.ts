/**
 * Stop-1 co-located entrypoint for the merge-execution-bridge tests
 * (WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01).
 *
 * The canonical suite lives at ./__tests__/merge-execution-bridge.test.ts (the
 * repo convention). The WO stop-condition command filters bun by the co-located
 * path `packages/overseer/src/merge-execution-bridge.test.ts`; bun treats that as
 * a substring filter that does NOT match the `__tests__/` segment, so this thin
 * re-import makes the full suite -- including Tests 19 and 20 -- run under the
 * Stop-1 command. describe()/test() register as import side effects, so no logic
 * is duplicated here.
 */
import './__tests__/merge-execution-bridge.test.ts';
