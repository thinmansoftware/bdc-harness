import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runAuthorizedEscalation } from '../authorized-escalation';

describe('runAuthorizedEscalation', () => {
  test('requires a permit and returns an inert receipt', async () => {
    const result = await runAuthorizedEscalation('run-no-permit', {
      permit: null,
      actor: 'test',
    });

    expect(result).toEqual({
      accepted: false,
      reason: 'permit_missing',
      mutation_sent: false,
    });
  });

  test('public boundary owns policy dependencies and exposes no side-effect callback', () => {
    const source = readFileSync(join(import.meta.dir, '../authorized-escalation.ts'), 'utf8');

    expect(runAuthorizedEscalation.length).toBe(2);
    expect(source).not.toContain('authorizationDeps');
    expect(source).not.toContain('perform?:');
    expect(source).not.toContain('runEscalation');
    expect(source).not.toContain("from './escalate'");
    expect(source.toLowerCase()).not.toContain('dispatch');
    expect(source.toLowerCase()).not.toContain('webhook');
    expect(source.toLowerCase()).not.toContain('notion');
    expect(source).not.toContain('writeFile');
    expect(source).toContain("adapter: 'fake-escalation'");
    expect(source).toContain('mutation_sent: false');
  });
});
