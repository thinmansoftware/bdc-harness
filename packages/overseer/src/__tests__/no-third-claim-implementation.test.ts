import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';

describe('claim implementation boundary', () => {
  test('recovery claim fencing routes through the approved ledger modules', () => {
    const action = readFileSync(
      join(import.meta.dir, '../actions/repair-refire.ts'),
      'utf8'
    );
    const adapter = readFileSync(
      join(import.meta.dir, '../adapters/repair-refire-claim.ts'),
      'utf8'
    );

    expect(action).toContain('acquireExecutionClaim');
    expect(action).toContain('validateExecutionFence');
    expect(adapter).toContain('@archon/core/db/recovery-execution-claims');
    expect(adapter).not.toContain('CREATE TABLE');
    expect(adapter).not.toContain('board_execution_claims');
  });
});
