import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { DispatchClient } from './dispatch-client';
import { ToolFailure } from './errors';
import { createSendLimiter } from './send-limit';
import { executeTool, type ToolDeps } from './tools/execute';
import { mailboxSend } from './tools/mailbox';
import { TrackedTree } from './tracked-tree';
import type { CompanionSlot } from './types';

function companionSlot(companionId: string): CompanionSlot {
  return {
    companion_id: companionId,
    enabled: true,
    dispatch_principal_id: companionId,
    token_sha256_file: '/tmp/companion.sha256',
    token_expires_at: '2099-01-01T00:00:00.000Z',
    token_expires_ms: Date.parse('2099-01-01T00:00:00.000Z'),
    dispatch_credential_file: '/tmp/companion',
    tools: ['mailbox_send'],
    allowed_recipients: ['xo'],
    board_secretary: false,
    board_seat_recipients: [],
  };
}

function recordingDispatch(texts: string[]): DispatchClient {
  return {
    send: async (_slot: CompanionSlot, input: { text: string }): Promise<void> => {
      texts.push(input.text);
    },
  } as unknown as DispatchClient;
}

function toolText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text' || first.text === undefined) {
    throw new Error('missing tool text');
  }
  return first.text;
}

describe('mailbox send limit', () => {
  test('1 accepts 4000 bytes and refuses 4001 without calling dispatch', async () => {
    const limiter = createSendLimiter();
    const slot = companionSlot('grokbot');
    const texts: string[] = [];
    const dispatch = recordingDispatch(texts);
    const at = Date.UTC(2026, 10, 13, 12, 0, 0);
    const body = 'a'.repeat(4000);

    const sent = await mailboxSend(dispatch, slot, 'xo', body, undefined, limiter, at);

    expect(sent.correlation_id.startsWith('companion-grokbot-')).toBe(true);
    expect(texts).toEqual([body]);

    await expect(
      mailboxSend(dispatch, slot, 'xo', 'b'.repeat(4001), undefined, limiter, at)
    ).rejects.toMatchObject({ outcome: 'refused', code: 'text_too_long' });
    expect(texts).toEqual([body]);
  });

  test('2 refuses 1334 three-byte characters as 4002 bytes', async () => {
    const limiter = createSendLimiter();
    const texts: string[] = [];
    const dispatch = recordingDispatch(texts);
    const text = '\u20AC'.repeat(1334);

    expect(text.length).toBe(1334);
    expect(text.length).toBeLessThan(4000);
    expect(new TextEncoder().encode(text).byteLength).toBe(4002);

    await expect(
      mailboxSend(dispatch, companionSlot('grokbot'), 'xo', text, 'euro', limiter, 0)
    ).rejects.toMatchObject({ outcome: 'refused', code: 'text_too_long' });
    expect(texts).toEqual([]);
  });

  test('3 enforces a rolling hour of 10 accepted sends', async () => {
    const limiter = createSendLimiter();
    const slot = companionSlot('grokbot');
    const texts: string[] = [];
    const dispatch = recordingDispatch(texts);
    const at = Date.UTC(2026, 10, 13, 12, 0, 0);

    for (let i = 0; i < 10; i += 1) {
      const sent = await mailboxSend(dispatch, slot, 'xo', 'hour', `h-${String(i)}`, limiter, at);
      expect(sent.correlation_id).toBe(`h-${String(i)}`);
    }
    expect(texts).toHaveLength(10);

    const later = at + 59 * 60 * 1000;
    await expect(
      mailboxSend(dispatch, slot, 'xo', 'hour', 'h-late', limiter, later)
    ).rejects.toMatchObject({ outcome: 'refused', code: 'send_rate_limited' });
    expect(texts).toHaveLength(10);

    const decision = limiter.tryAcquire(slot.companion_id, later);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAtMs).toBe(at + 3_600_000);

    const opened = await mailboxSend(
      dispatch,
      slot,
      'xo',
      'hour',
      'h-open',
      limiter,
      at + 3_600_000
    );
    expect(opened.correlation_id).toBe('h-open');
    expect(texts).toHaveLength(11);
  });

  test('4 enforces 40 accepted sends per UTC day', async () => {
    const limiter = createSendLimiter();
    const slot = companionSlot('grokbot');
    const texts: string[] = [];
    const dispatch = recordingDispatch(texts);
    const start = Date.UTC(2026, 10, 13);
    const stepMs = 7 * 60 * 1000;

    for (let i = 0; i < 40; i += 1) {
      const sent = await mailboxSend(
        dispatch,
        slot,
        'xo',
        'day',
        `d-${String(i)}`,
        limiter,
        start + i * stepMs
      );
      expect(sent.correlation_id).toBe(`d-${String(i)}`);
    }
    expect(texts).toHaveLength(40);

    const over = start + 40 * stepMs;
    await expect(
      mailboxSend(dispatch, slot, 'xo', 'day', 'd-over', limiter, over)
    ).rejects.toMatchObject({ outcome: 'refused', code: 'send_rate_limited' });
    expect(texts).toHaveLength(40);

    const decision = limiter.tryAcquire(slot.companion_id, over);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAtMs).toBe(Date.UTC(2026, 10, 14));

    const nextDay = await mailboxSend(
      dispatch,
      slot,
      'xo',
      'day',
      'd-next',
      limiter,
      Date.UTC(2026, 10, 14)
    );
    expect(nextDay.correlation_id).toBe('d-next');
    expect(texts).toHaveLength(41);
  });

  test('5 lets another slot send when one slot is at its hour cap', async () => {
    const limiter = createSendLimiter();
    const slotA = companionSlot('slot-a');
    const slotB = companionSlot('slot-b');
    const texts: string[] = [];
    const dispatch = recordingDispatch(texts);
    const at = Date.UTC(2026, 10, 13, 12, 0, 0);

    for (let i = 0; i < 10; i += 1) {
      await mailboxSend(dispatch, slotA, 'xo', 'a', `a-${String(i)}`, limiter, at);
    }
    await expect(
      mailboxSend(dispatch, slotA, 'xo', 'a', 'a-over', limiter, at)
    ).rejects.toMatchObject({ outcome: 'refused', code: 'send_rate_limited' });

    const sent = await mailboxSend(dispatch, slotB, 'xo', 'b', 'b-1', limiter, at);
    expect(sent.correlation_id).toBe('b-1');
    expect(texts).toEqual([...Array<string>(10).fill('a'), 'b']);
  });

  test('6 counts failed dispatch sends and omits refusal text from the audit', async () => {
    const limiter = createSendLimiter();
    const dir = await mkdtemp(join(tmpdir(), 'send-limit-'));
    const auditLog = join(dir, 'audit.log');
    let calls = 0;
    const dispatch = {
      send: async (): Promise<void> => {
        calls += 1;
        throw new Error('dispatch down');
      },
    } as unknown as DispatchClient;
    const deps: ToolDeps = {
      wikiRoot: dir,
      tree: new TrackedTree(dir),
      oracleUrl: 'http://127.0.0.1:9',
      dispatch,
      auditLog,
      env: {},
      sendLimit: limiter,
    };
    const slot = companionSlot('grokbot');
    const overlongMarker = 'OVERLONG-MARKER';
    const shortMarker = 'SHORT-BODY-MARKER';
    const overlong = `${overlongMarker}${'x'.repeat(4000)}`;

    try {
      const longResult = await executeTool(
        slot,
        'mailbox_send',
        { recipient: 'xo', text: overlong },
        deps
      );
      expect(longResult.isError).toBe(true);
      expect(toolText(longResult)).toBe('{"error":"text_too_long"}');
      expect(calls).toBe(0);

      for (let i = 0; i < 10; i += 1) {
        const failed = await executeTool(
          slot,
          'mailbox_send',
          { recipient: 'xo', text: shortMarker },
          deps
        );
        expect(failed.isError).toBe(true);
        expect(toolText(failed)).toBe('{"error":"internal_error"}');
      }
      expect(calls).toBe(10);

      const limited = await executeTool(
        slot,
        'mailbox_send',
        { recipient: 'xo', text: shortMarker },
        deps
      );
      expect(toolText(limited)).toBe('{"error":"send_rate_limited"}');
      expect(calls).toBe(10);

      const lines = (await readFile(auditLog, 'utf8'))
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      expect(lines).toHaveLength(12);
      const events = lines.map(
        line =>
          JSON.parse(line) as { outcome: string; error?: string; args: Record<string, unknown> }
      );
      const refusals = events.filter(event => event.outcome === 'refused');
      expect(refusals.map(event => event.error)).toEqual(['text_too_long', 'send_rate_limited']);
      expect(JSON.stringify(refusals[0])).not.toContain(overlongMarker);
      expect(refusals[0]?.args.text).toBeUndefined();
      expect(JSON.stringify(refusals[1])).not.toContain(shortMarker);
      expect(refusals[1]?.args.text).toBeUndefined();
      const failures = events.filter(event => event.outcome === 'error');
      expect(failures).toHaveLength(10);
      expect(JSON.stringify(failures)).toContain(shortMarker);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('7 a new limiter instance starts at zero after a restart', async () => {
    const first = createSendLimiter();
    const slot = companionSlot('grokbot');
    const texts: string[] = [];
    const dispatch = recordingDispatch(texts);
    const at = Date.UTC(2026, 10, 13, 12, 0, 0);

    for (let i = 0; i < 10; i += 1) {
      await mailboxSend(dispatch, slot, 'xo', 'old', `old-${String(i)}`, first, at);
    }
    await expect(
      mailboxSend(dispatch, slot, 'xo', 'old', 'old-over', first, at)
    ).rejects.toMatchObject({ outcome: 'refused', code: 'send_rate_limited' });

    // A new instance is what a process restart does. Counts are not persisted.
    const restarted = createSendLimiter();
    const sent = await mailboxSend(dispatch, slot, 'xo', 'new', 'after-restart', restarted, at);
    expect(sent.correlation_id).toBe('after-restart');
    expect(texts).toEqual([...Array<string>(10).fill('old'), 'new']);
  });

  test('8 concurrent calls cannot all pass the last free slot', async () => {
    const limiter = createSendLimiter();
    const slot = companionSlot('grokbot');
    const at = Date.UTC(2026, 10, 13, 15, 0, 0);
    const fast = {
      send: async (): Promise<void> => {
        return undefined;
      },
    } as unknown as DispatchClient;
    for (let i = 0; i < 9; i += 1) {
      const seeded = await mailboxSend(fast, slot, 'xo', 'seed', `seed-${String(i)}`, limiter, at);
      expect(seeded.correlation_id).toBe(`seed-${String(i)}`);
    }

    let entered = 0;
    let release = (): void => {
      return undefined;
    };
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const slow = {
      send: async (): Promise<void> => {
        entered += 1;
        await gate;
      },
    } as unknown as DispatchClient;

    const pending = [0, 1, 2].map(index =>
      mailboxSend(slow, slot, 'xo', 'race', `race-${String(index)}`, limiter, at).then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
    );

    for (let i = 0; i < 20 && entered < 1; i += 1) {
      await Promise.resolve();
    }
    expect(entered).toBe(1);
    release();

    const results = await Promise.all(pending);
    let accepted = 0;
    let refused = 0;
    for (const result of results) {
      if (result.ok) {
        accepted += 1;
        expect(result.value.correlation_id.startsWith('race-')).toBe(true);
      } else {
        refused += 1;
        expect(result.error).toBeInstanceOf(ToolFailure);
        if (!(result.error instanceof ToolFailure)) {
          throw new Error('expected ToolFailure');
        }
        expect(result.error.code).toBe('send_rate_limited');
        expect(result.error.outcome).toBe('refused');
      }
    }
    expect(accepted).toBe(1);
    expect(refused).toBe(2);
    expect(entered).toBe(1);
  });
});
