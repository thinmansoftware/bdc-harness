import { spyOn } from 'bun:test';
import * as ladder from '../ladder.js';

/**
 * The live ladder refuses the "claude" tier (WO-HARNESS-REFUSE-CLAUDE-LADDER-TIER-01). Tests that
 * exercise the Claude admission machinery (seat headroom, seat cutoff, climbs that land on it) run
 * with the earlier refused list so the machinery stays covered. Returns the restore function.
 */
export function openClaudeTier(): () => void {
  const spy = spyOn(ladder, 'loadRefusedTiers').mockReturnValue(['glm', 'qwen']);
  return () => {
    spy.mockRestore();
  };
}
