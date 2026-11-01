import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { describe, expect, test } from 'bun:test';

import { utcCompact } from './constants';
import type { CompanionSendInput, DispatchClient } from './dispatch-client';
import {
  createSessionAdmissions,
  evictLeastRecentIfAtCap,
  sweepIdleSessions,
  touchSession,
  type SessionRecord,
} from './server';
import { boardBriefSend } from './tools/mailbox';
import type { CompanionSlot } from './types';

function admit(
  sessions: Map<string, SessionRecord>,
  id: string,
  nowMs: number,
  log: string[]
): void {
  const transport = {
    close: async (): Promise<void> => {
      log.push(`${id}:transport`);
    },
  };
  const server = {
    close: async (): Promise<void> => {
      log.push(`${id}:server`);
    },
  };
  sessions.set(id, {
    transport: transport as unknown as StreamableHTTPServerTransport,
    server: server as unknown as McpServer,
    companionId: id,
    lastActivityMs: nowMs,
  });
}

describe('companion session limits', () => {
  test('idle session expires', async () => {
    const sessions = new Map<string, SessionRecord>();
    const log: string[] = [];
    admit(sessions, 's1', 0, log);

    await sweepIdleSessions(sessions, 1500, 1000);

    expect(log).toEqual(['s1:transport', 's1:server']);
    expect(sessions.size).toBe(0);

    await sweepIdleSessions(sessions, 1500, 1000);

    expect(log).toEqual(['s1:transport', 's1:server']);
    expect(sessions.size).toBe(0);
  });

  test('active session survives', async () => {
    const sessions = new Map<string, SessionRecord>();
    const log: string[] = [];
    admit(sessions, 's1', 0, log);
    touchSession(sessions, 's1', 900);

    await sweepIdleSessions(sessions, 1500, 1000);

    expect(sessions.has('s1')).toBe(true);
    expect(log).toEqual([]);
  });

  test('cap evicts least recent', async () => {
    const sessions = new Map<string, SessionRecord>();
    const log: string[] = [];

    await evictLeastRecentIfAtCap(sessions, 2);
    admit(sessions, 'A', 1, log);
    await evictLeastRecentIfAtCap(sessions, 2);
    admit(sessions, 'B', 2, log);
    await evictLeastRecentIfAtCap(sessions, 2);
    admit(sessions, 'C', 3, log);

    expect(log).toEqual(['A:transport', 'A:server']);
    expect(sessions.has('A')).toBe(false);
    expect(sessions.has('B')).toBe(true);
    expect(sessions.has('C')).toBe(true);
    expect(sessions.size).toBe(2);
  });

  test('concurrent initialization reserves before cleanup', async () => {
    class PeakMap extends Map<string, SessionRecord> {
      peak = 0;
      override set(key: string, value: SessionRecord): this {
        const out = super.set(key, value);
        if (this.size > this.peak) {
          this.peak = this.size;
        }
        return out;
      }
    }

    const sessions = new PeakMap();
    const maxSessions = 2;
    const admitSession = createSessionAdmissions(sessions, maxSessions);
    let releaseClose = (): void => {
      return undefined;
    };
    const closeGate = new Promise<void>(resolve => {
      releaseClose = resolve;
    });
    let closeEntered = 0;

    const blocking = (id: string, nowMs: number): SessionRecord => {
      const transport = {
        close: async (): Promise<void> => {
          closeEntered += 1;
          await closeGate;
        },
      };
      const server = {
        close: async (): Promise<void> => {
          return undefined;
        },
      };
      return {
        transport: transport as unknown as StreamableHTTPServerTransport,
        server: server as unknown as McpServer,
        companionId: id,
        lastActivityMs: nowMs,
      };
    };

    sessions.set('A', blocking('A', 1));
    sessions.set('B', blocking('B', 2));

    const pendingC = admitSession('C', blocking('C', 3));
    const pendingD = admitSession('D', blocking('D', 4));

    for (let i = 0; i < 20 && closeEntered < 1; i += 1) {
      await Promise.resolve();
    }
    expect(closeEntered).toBe(1);
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    expect(sessions.has('C')).toBe(true);
    expect(sessions.has('D')).toBe(false);
    expect(sessions.size).toBe(maxSessions);
    expect(sessions.peak).toBeLessThanOrEqual(maxSessions);

    releaseClose();
    await Promise.all([pendingC, pendingD]);

    expect(closeEntered).toBe(2);
    expect(sessions.size).toBe(maxSessions);
    expect(sessions.has('A')).toBe(false);
    expect(sessions.has('B')).toBe(false);
    expect(sessions.has('C')).toBe(true);
    expect(sessions.has('D')).toBe(true);
    expect(sessions.peak).toBeLessThanOrEqual(maxSessions);
  });

  test('unique brief correlation IDs', async () => {
    const now = new Date('2026-11-01T22:08:09.500Z');
    const prefix = `board-brief-M-1-${utcCompact(now)}-`;
    const slot: CompanionSlot = {
      companion_id: 'secretary',
      enabled: true,
      dispatch_principal_id: 'secretary',
      token_sha256_file: 'token',
      token_expires_at: '2099-01-01T00:00:00.000Z',
      token_expires_ms: Date.parse('2099-01-01T00:00:00.000Z'),
      dispatch_credential_file: 'cred',
      tools: ['board_brief_send'],
      allowed_recipients: [],
      board_secretary: true,
      board_seat_recipients: ['astra'],
    };
    const sent: string[] = [];
    const dispatch = {
      send: async (_slot: CompanionSlot, input: CompanionSendInput): Promise<void> => {
        sent.push(input.correlationId);
      },
    } as unknown as DispatchClient;

    const first = await boardBriefSend(dispatch, slot, 'M-1', ['astra'], 'brief', now);
    const second = await boardBriefSend(dispatch, slot, 'M-1', ['astra'], 'brief', now);

    expect(first.correlation_id).not.toBe(second.correlation_id);
    expect(first.correlation_id.startsWith(prefix)).toBe(true);
    expect(second.correlation_id.startsWith(prefix)).toBe(true);
    expect(sent).toEqual([first.correlation_id, second.correlation_id]);
  });
});
