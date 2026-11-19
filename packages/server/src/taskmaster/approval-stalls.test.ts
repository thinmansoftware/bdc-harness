import { test, expect } from 'bun:test';
import { approvalPass, type ApprovalDeps, type ApprovalState } from './approval-stalls';
function harness() {
  const states = new Map<string, ApprovalState>();
  const sent: { recipient: string; body: string; key: string }[] = [];
  const closed: string[] = [];
  const deps: ApprovalDeps = {
    read: async () => [...states.values()],
    save: async state => {
      states.set(state.request_id, structuredClone(state));
    },
    send: async (recipient, body, key) => {
      sent.push({ recipient, body, key });
      return key;
    },
    expect: async () => {},
    close: async id => {
      closed.push(id);
    },
  };
  return { states, sent, closed, deps };
}
const breach = {
  schema: 't3-approval-breach/v1',
  thread_id: 'mcp:465e5afa',
  thread_title: 'Owner',
  project: 'Build',
  request_id: 'runtime-request:1',
  kind: 'command',
  command_head: 'bun test',
  created_at: '2026-11-06T10:00:00Z',
  age_min: 20,
  host: 'desktop',
};
const now = new Date('2026-11-06T10:20:00Z');
test('Stop 1: repeated breach retains one durable request', async () => {
  const h = harness();
  await approvalPass([breach, breach], now, h.deps);
  await approvalPass([breach], now, h.deps);
  expect(h.states.size).toBe(1);
  expect(h.states.get(breach.request_id)?.thread_id).toBe(breach.thread_id);
  expect(h.sent).toHaveLength(1);
});
test('Stop 2: relay nudge preserves exact thread and request', async () => {
  const h = harness();
  await approvalPass([breach], now, h.deps);
  expect(h.sent[0]?.recipient).toBe('t3-desk-local');
  expect(JSON.parse(h.sent[0]!.body)).toMatchObject({
    schema: 't3-thread-nudge/v1',
    thread_id: breach.thread_id,
    request_id: breach.request_id,
    reason: 'approval-stall',
  });
});
test('Stop 3: unresolved breach enters existing DO to XO ladder after interval', async () => {
  const h = harness();
  await approvalPass([breach], now, h.deps);
  expect(h.sent).toHaveLength(1);
  await approvalPass([], new Date(now.getTime() + 15 * 60000), h.deps);
  expect(h.sent[1]?.recipient).toBe('duty-officer');
  expect(h.sent[1]?.key.startsWith('tm:blocker_report:')).toBe(true);
  expect(h.sent[1]?.body).toContain('bun test');
  expect(h.sent[1]?.body).toContain(breach.thread_id);
  expect(h.sent[1]?.body).toContain('35 min');
});
test('Stop 4: resolution closes expectation and prevents subsequent escalation', async () => {
  const h = harness();
  await approvalPass([breach], now, h.deps);
  await approvalPass(
    [
      {
        schema: 't3-approval-resolved/v1',
        request_id: breach.request_id,
        thread_id: breach.thread_id,
        resolved_at: now.toISOString(),
      },
    ],
    new Date(now.getTime() + 15 * 60000),
    h.deps
  );
  await approvalPass([breach], new Date(now.getTime() + 60 * 60000), h.deps);
  expect(h.closed).toEqual([breach.request_id]);
  expect(h.sent).toHaveLength(1);
});
test('Stop 5: empty inbox writes no breach row', async () => {
  const h = harness();
  await approvalPass([], now, h.deps);
  expect(h.states.size).toBe(0);
  expect(h.sent).toHaveLength(0);
});
test('invalid or young breach and wrong-thread resolution have no authority', async () => {
  const h = harness();
  await approvalPass([{ ...breach, age_min: 1 }], now, h.deps);
  expect(h.states.size).toBe(0);
  await approvalPass([breach], now, h.deps);
  await approvalPass(
    [
      {
        schema: 't3-approval-resolved/v1',
        request_id: breach.request_id,
        thread_id: 'wrong',
        resolved_at: now.toISOString(),
      },
    ],
    now,
    h.deps
  );
  expect(h.closed).toHaveLength(0);
});
