import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '../db/adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('../db/connection', () => ({
  getDatabase: () => db,
}));

import {
  boardMotionPayloadSchema,
  deriveBoardMotionNotificationKey,
  recordBoardPetitionDelivery,
  validateBoardMotionPointer,
} from './board-motion-pointer';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function fetcherFor(text: string, sha = 'a'.repeat(40)): typeof fetch {
  return (async (url: string) => {
    if (url.includes('/git/ref/heads/main')) {
      return Response.json({ object: { sha: 'b'.repeat(40) } });
    }
    return Response.json({
      type: 'file',
      sha,
      content: Buffer.from(text, 'utf8').toString('base64'),
    });
  }) as typeof fetch;
}

describe('board motion pointer', () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'test-token';
    currentDbPath = join(
      import.meta.dir,
      `.test-board-motion-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    delete process.env.GITHUB_TOKEN;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('validates pointer-only payload and derives revision key', async () => {
    const pointer = await validateBoardMotionPointer(
      {
        motion_id: 'M-27',
        title: 'Board Motion Dispatch',
        file_path: 'docs/board/motions/M-27.md',
      },
      { fetcher: fetcherFor('# M-27: Board Motion Dispatch\n') }
    );

    expect(pointer.motion_revision_sha).toBe('a'.repeat(40));
    expect(
      deriveBoardMotionNotificationKey({
        motion_id: pointer.payload.motion_id,
        motion_revision_sha: pointer.motion_revision_sha,
      })
    ).toBe(`board-motion:M-27:${'a'.repeat(40)}:board`);
  });

  test('allows a new canonical revision to produce a different notification key', async () => {
    const oldKey = deriveBoardMotionNotificationKey({
      motion_id: 'M-27',
      motion_revision_sha: 'a'.repeat(40),
    });
    const newKey = deriveBoardMotionNotificationKey({
      motion_id: 'M-27',
      motion_revision_sha: 'b'.repeat(40),
    });
    expect(newKey).not.toBe(oldKey);
  });

  test('rejects rich, unknown, absolute, traversal, and url payloads', () => {
    for (const payload of [
      { motion_id: 'M-27', title: 'T', file_path: '/docs/board/motions/M.md' },
      { motion_id: 'M-27', title: 'T', file_path: 'docs/board/motions/../M.md' },
      { motion_id: 'M-27', title: 'T', file_path: 'https://example.com/M.md' },
      { motion_id: 'M-27', title: 'T', file_path: 'docs/board/motions/M.md', motion_text: 'x' },
      { motion_id: 'M-27', title: 'T', file_path: 'docs/board/motions/M.md', ballot: 'APPROVE' },
      { motion_id: 'M-27', title: 'T', file_path: 'docs/board/motions/M.md', execute: true },
    ]) {
      expect(boardMotionPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  test('rejects canonical metadata spoofing', async () => {
    await expect(
      validateBoardMotionPointer(
        {
          motion_id: 'M-27',
          title: 'Claimed Title',
          file_path: 'docs/board/motions/M-27.md',
        },
        { fetcher: fetcherFor('# M-27: Real Title\n') }
      )
    ).rejects.toThrow('metadata mismatch');
  });

  test('records board petition evidence without creating authority state', async () => {
    await recordBoardPetitionDelivery({
      actor_principal_id: 'claude',
      actor_seat_id: 'xo',
      body: {
        motion_id: 'M-27',
        file_path: 'docs/board/motions/M-27.md',
        requested_action: 'open discussion',
      },
      dispatch_message_id: 'dispatch-1',
      dependencies: { fetcher: fetcherFor('# M-27: Petition\n', 'c'.repeat(40)) },
    });

    const events = await db.query<{ event_type: string; details: string }>(
      'SELECT event_type, details FROM board_audit_events'
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].event_type).toBe('board_petition_delivered');
    expect(events.rows[0].details).toContain('dispatch-1');
  });
});
