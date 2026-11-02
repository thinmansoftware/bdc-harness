/**
 * wo-fire-guard.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { extractWoIdFromMessage, isCascadeClimbMessage } from './wo-fire-guard';

describe('wo-fire-guard', () => {
  test('extracts WO_ID from fire messages', () => {
    expect(extractWoIdFromMessage('WO_ID=WO-SHOPOPS-GARY-01 --project shopops')).toBe(
      'WO-SHOPOPS-GARY-01'
    );
    expect(extractWoIdFromMessage('no wo here')).toBeNull();
  });

  test('detects cascade climb context', () => {
    expect(isCascadeClimbMessage('WO_ID=WO-X-01\n\n## Prior attempt context\nfoo')).toBe(true);
    expect(isCascadeClimbMessage('WO_ID=WO-X-01 --project shopops')).toBe(false);
  });
});
