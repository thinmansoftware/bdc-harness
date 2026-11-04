/**
 * Tests 5-6 (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01): the liveness
 * monitor alarms once per silence episode after 10 minutes, retries a failed
 * page, stays quiet while passes run, and re-arms on recovery.
 */
import { describe, expect, test } from 'bun:test';
import {
  recordSweepProgress,
  startMergeSweepLivenessMonitor,
  type LivenessLogger,
} from '../merge-sweep-liveness.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 16, 30, 0);

interface Entry {
  level: 'info' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function harness(failFirstPosts = 0) {
  const entries: Entry[] = [];
  const logger: LivenessLogger = {
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
  };
  const posts: Array<{ context: unknown; data: Record<string, unknown> }> = [];
  let postAttempts = 0;
  let clock = T0;
  const monitor = startMergeSweepLivenessMonitor({
    now: () => clock,
    logger,
    maxSilenceMs: 10 * MIN,
    checkIntervalMs: MIN,
    startTimer: false,
    createMessage: async (context, data) => {
      postAttempts += 1;
      if (postAttempts <= failFirstPosts) throw new Error('dispatch_unavailable');
      posts.push({ context, data: data as unknown as Record<string, unknown> });
      return undefined;
    },
  });
  return {
    monitor,
    entries,
    posts,
    attempts: () => postAttempts,
    advance: (ms: number): void => {
      clock += ms;
    },
    now: (): number => clock,
  };
}

const alarms = (entries: Entry[]): Entry[] =>
  entries.filter(entry => entry.msg === 'merge-coordinator.liveness_alarm');

describe('merge sweep liveness monitor', () => {
  test('Test 5: alarms after 10 minutes with no pass, once per episode, retrying a failed post', async () => {
    const h = harness(1);
    try {
      h.advance(9 * MIN + 59_000);
      await h.monitor.check();
      expect(alarms(h.entries)).toHaveLength(0);
      expect(h.attempts()).toBe(0);

      // First check past the threshold: the alarm logs, the post throws.
      h.advance(2_000);
      expect(await h.monitor.check()).toBe(true);
      expect(alarms(h.entries)).toHaveLength(1);
      expect(alarms(h.entries)[0]?.level).toBe('error');
      expect(h.attempts()).toBe(1);
      expect(h.posts).toHaveLength(0);

      // The next check retries the page and succeeds.
      h.advance(MIN);
      await h.monitor.check();
      expect(h.attempts()).toBe(2);
      expect(h.posts).toHaveLength(1);

      // Five more silent checks: the error logs again each time, no second post.
      for (let i = 0; i < 5; i += 1) {
        h.advance(MIN);
        await h.monitor.check();
      }
      expect(alarms(h.entries)).toHaveLength(7);
      expect(h.attempts()).toBe(2);
      expect(h.posts).toHaveLength(1);

      const [post] = h.posts;
      expect(post?.context).toEqual({ kind: 'system', sender: 'overseer' });
      expect(post?.data.recipient).toBe('operator');
      expect(post?.data.priority).toBe('blocker');
      expect(post?.data.task_type).toBe('agent_message');
      expect(typeof post?.data.idempotency_key).toBe('string');
      expect(post?.data.idempotency_key).toBe(`overseer:${String(post?.data.correlation_id)}`);
      expect(String(post?.data.body)).toContain('Merge sweep liveness alarm');
    } finally {
      h.monitor.stop();
    }
  });

  test('Test 6: quiet while passes run, re-alarms with a new key in a new episode, disabled at 0', async () => {
    const h = harness();
    try {
      // 30 healthy minutes: progress every 2 minutes, checks every minute.
      recordSweepProgress(h.now());
      for (let minute = 1; minute <= 30; minute += 1) {
        h.advance(MIN);
        if (minute % 2 === 0) recordSweepProgress(h.now());
        await h.monitor.check();
      }
      expect(alarms(h.entries)).toHaveLength(0);
      expect(h.posts).toHaveLength(0);

      // First 12-minute gap: one alarm episode, one post.
      for (let minute = 1; minute <= 12; minute += 1) {
        h.advance(MIN);
        await h.monitor.check();
      }
      expect(h.posts).toHaveLength(1);
      expect(alarms(h.entries).length).toBeGreaterThanOrEqual(1);

      // Progress resumes: recovery is logged and the monitor re-arms.
      recordSweepProgress(h.now());
      await h.monitor.check();
      expect(h.entries.some(entry => entry.msg === 'merge-coordinator.liveness_recovered')).toBe(
        true
      );

      // Second 12-minute gap: a second alarm and a second post with a different key.
      for (let minute = 1; minute <= 12; minute += 1) {
        h.advance(MIN);
        await h.monitor.check();
      }
      expect(h.posts).toHaveLength(2);
      expect(h.posts[1]?.data.idempotency_key).not.toBe(h.posts[0]?.data.idempotency_key);
    } finally {
      h.monitor.stop();
    }

    // Max silence 0 disables the monitor: no timer is armed and check() is inert.
    const realSetInterval = globalThis.setInterval;
    let intervalsArmed = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervalsArmed += 1;
      return realSetInterval(...args);
    }) as typeof setInterval;
    try {
      const disabled = startMergeSweepLivenessMonitor({
        maxSilenceMs: 0,
        logger: { info: () => undefined, error: () => undefined },
      });
      expect(intervalsArmed).toBe(0);
      expect(await disabled.check()).toBe(false);
      disabled.stop();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});
