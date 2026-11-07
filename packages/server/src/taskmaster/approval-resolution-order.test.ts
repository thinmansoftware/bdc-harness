import { test, expect } from 'bun:test';
import { approvalPass } from './approval-stalls';
test('resolution before breach writes no breach row and suppresses stale replay', async () => {
  const saved: unknown[] = [];
  const sent: unknown[] = [];
  const now = new Date('2026-11-06T10:20:00Z');
  const resolution = {
    schema: 't3-approval-resolved/v1',
    request_id: 'r1',
    thread_id: 'mcp:1',
    resolved_at: now.toISOString(),
  };
  const deps = {
    read: async () => [],
    save: async (s: unknown) => {
      saved.push(s);
    },
    send: async (...args: unknown[]) => {
      sent.push(args);
      return 'd';
    },
    expect: async () => {},
    close: async () => {},
  };
  await approvalPass([resolution], now, deps);
  expect(saved).toHaveLength(0);
  await approvalPass(
    [
      resolution,
      {
        schema: 't3-approval-breach/v1',
        request_id: 'r1',
        thread_id: 'mcp:1',
        host: 'desktop',
        kind: 'command',
        command_head: 'bun test',
        created_at: '2026-11-06T10:00:00Z',
        age_min: 20,
      },
    ],
    now,
    deps
  );
  expect(saved).toHaveLength(0);
  expect(sent).toHaveLength(0);
});
