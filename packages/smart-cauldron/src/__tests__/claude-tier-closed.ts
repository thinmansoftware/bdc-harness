import { spyOn } from 'bun:test';
import * as ladder from '../ladder.js';

/**
 * The live ladder admits the "claude" tier again (WO-HARNESS-CLAUDE-LANE-REOPEN-95-01). Tests of
 * the frontier approval gate and the codex-to-frontier climb pin claude closed, so a climb from
 * codex reaches frontier whatever the live ladder says. Returns the restore function.
 */
export function closeClaudeTier(): () => void {
  const spy = spyOn(ladder, 'loadRefusedTiers').mockReturnValue(['glm', 'qwen', 'claude']);
  return () => {
    spy.mockRestore();
  };
}
