import { describe, expect, it } from 'bun:test';
import { digestProposal } from './loop';

describe('Test 7: GitHub quota digest', () => {
  it('reports services, resources, and strict low warnings', () => {
    const body = digestProposal(
      [],
      {
        pause_state: 'RUNNING',
        pause_scope: null,
        pause_actor: null,
        pause_reason: null,
        epoch: 1,
        updated_at: '2026-10-14T00:00:00Z',
      },
      Date.parse('2026-10-14T00:00:00Z'),
      undefined,
      [],
      {
        usage: [
          { service: 'merge_manager', pool_id: 'app-y', calls: 24, peak: 3 },
          { service: 'taskmaster', pool_id: 'app-y', calls: 48, peak: 4 },
          { service: 'overseer', pool_id: 'app-x', calls: 12, peak: 2 },
        ],
        pools: [
          { pool_id: 'app-y', resource: 'core', remaining: 900, limit: 15000 },
          { pool_id: 'app-y', resource: 'search', remaining: 25, limit: 30 },
          { pool_id: 'app-x', resource: 'core', remaining: 14000, limit: 15000 },
        ],
        servicesByPool: new Map([
          ['app-y', ['merge_manager', 'taskmaster']],
          ['app-x', ['overseer']],
        ]),
      },
      ['thinmansoftware/bdc-xo#99 WO-REPAIR awaiting review']
    ).body;
    expect(body).toContain('thinmansoftware/bdc-xo#99 WO-REPAIR awaiting review');
    expect(body).toContain('GitHub API last 24h by service: merge_manager');
    expect(body).toContain('app-y/core 900/15000');
    expect(body).toContain('GITHUB-QUOTA-LOW app-y/core (merge_manager, taskmaster)');
    expect(body).not.toContain('GITHUB-QUOTA-LOW app-y/search');
  });
});
