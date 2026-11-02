import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { SqliteAdapter } from '../../core/src/db/adapters/sqlite.ts';

describe('companion dispatch principals', () => {
  test('companion_principals_seeded_in_sqlite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'companion-principals-'));
    const db = new SqliteAdapter(join(dir, 'archon.db'));
    try {
      const principals = await db.query<{
        principal_id: string;
        display_name: string;
        delivery_mode: string;
        active: number;
      }>(
        `SELECT principal_id, display_name, delivery_mode, active
         FROM dispatch_principals
         WHERE principal_id IN ('grokbot', 'dot', 'muse', 'duet')
         ORDER BY principal_id`
      );
      expect(principals.rows).toEqual([
        {
          principal_id: 'dot',
          display_name: 'Dot (voice companion)',
          delivery_mode: 'drain_on_start',
          active: 0,
        },
        {
          principal_id: 'duet',
          display_name: 'Duet (voice companion)',
          delivery_mode: 'drain_on_start',
          active: 0,
        },
        {
          principal_id: 'grokbot',
          display_name: 'Grok Bot (voice companion)',
          delivery_mode: 'drain_on_start',
          active: 1,
        },
        {
          principal_id: 'muse',
          display_name: 'Muse (voice companion)',
          delivery_mode: 'drain_on_start',
          active: 0,
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
