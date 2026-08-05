/**
 * ACP session reliability tests -- WO-HARNESS-ACP-DISPATCH-SLICE-01.
 *
 * These drive runAcpAgent against REAL child processes (a stub ACP agent and
 * a deliberately hostile one), not mocks, because the M-118 ruling's
 * acceptance criteria are about actual process behavior: does an idle agent
 * get cancelled, do descendants actually die, is an empty success honestly
 * classified.
 */
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { runAcpAgent, createCancelController } from './session';
import { enumerateProcessTree } from './kill-tree';

/**
 * Stub-agent misbehavior modes. Exported so the seat-parameterized
 * conformance harness (acp/conformance.ts + acp/conformance.test.ts) reuses
 * ONE stub implementation rather than forking a second one
 * (WO-HARNESS-GROK-ACP-PROMOTION-01, spec section 4).
 *
 * - 'ok'          completes a real prompt turn with non-empty output.
 * - 'empty'       clean end_turn with no output (honest-completion failure).
 * - 'hang'        never answers -- the idle timeout must fire.
 * - 'spawn-child' spawns a grandchild then hangs; on session/cancel it EXITS
 *                 itself (the original slice test relies on this exit).
 * - 'cancel-tree' hangs and DELIBERATELY IGNORES session/cancel, so Dispatch's
 *                 bounded tree-kill (not a cooperative agent exit) is what
 *                 removes it -- the Order-4 force-kill path for a
 *                 non-cooperative agent.
 * - 'auth-reject' advertises the cached_token auth method then rejects the
 *                 `authenticate` RPC, simulating an expired cached_token
 *                 (Gate B: the leg must fail loud, never leave a stuck queue).
 */
export type StubMode = 'ok' | 'empty' | 'hang' | 'spawn-child' | 'cancel-tree' | 'auth-reject';

/**
 * Minimal ACP agent over stdio: answers initialize/authenticate/session/new/
 * session/prompt with newline-delimited JSON-RPC. `mode` controls the
 * misbehavior under test.
 */
export function stubAgentSource(mode: StubMode): string {
  return `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const mode = ${JSON.stringify(mode)};
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      const authMethods = mode === 'auth-reject'
        ? [{ id: 'cached_token', name: 'Cached Token' }]
        : [];
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods } });
    } else if (msg.method === 'authenticate') {
      // Gate B: an expired cached_token must fail loud. Reject the RPC with an
      // auth-related message so the dispatch result carries an honest reason.
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'cached_token expired: authentication rejected' } });
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    } else if (msg.method === 'session/prompt') {
      if (mode === 'spawn-child') {
        const { spawn } = require('child_process');
        // Long-lived grandchild that must be killed with the tree.
        spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
      }
      if (mode === 'hang' || mode === 'spawn-child' || mode === 'cancel-tree') {
        return; // never answers -- idle timeout or cancellation must fire
      }
      if (mode === 'empty') {
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        return;
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP_STUB_OK' } },
      }});
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (msg.method === 'session/cancel') {
      if (mode === 'cancel-tree') {
        // Do NOT exit: force Dispatch's bounded tree-kill to remove this
        // process and its grandchild (Order-4 descendant-cleanup proof).
        return;
      }
      process.exit(0);
    }
  }
});
setInterval(() => {}, 1e9);
`;
}

export async function writeStub(mode: StubMode): Promise<{
  script: string;
  cwd: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'acp-stub-'));
  const script = join(cwd, 'stub-agent.cjs');
  await writeFile(script, stubAgentSource(mode), 'utf8');
  return { script, cwd };
}

describe('runAcpAgent reliability contract', () => {
  test('completes honestly on a real prompt turn', async () => {
    const { script, cwd } = await writeStub('ok');
    const result = await runAcpAgent(
      {
        command: process.execPath,
        args: [script],
        cwd,
        idleTimeoutMs: 10_000,
        wallClockMs: 20_000,
        killGraceMs: 1_000,
      },
      'say hi'
    );
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toContain('ACP_STUB_OK');
    // Durable receipt: the update stream is captured, not just the final text.
    expect(result.updates.length).toBeGreaterThan(0);
  }, 30_000);

  test('classifies an empty successful exit as NOT completed work', async () => {
    // M-118: "Do not treat transport success as proof that the requested work
    // completed." A clean end_turn with no output is a failure, not a done.
    const { script, cwd } = await writeStub('empty');
    const result = await runAcpAgent(
      {
        command: process.execPath,
        args: [script],
        cwd,
        idleTimeoutMs: 10_000,
        wallClockMs: 20_000,
        killGraceMs: 1_000,
      },
      'produce nothing'
    );
    expect(result.stopReason).toBe('end_turn');
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('empty_success_exit');
  }, 30_000);

  test('idle timeout cancels a hung agent and reports the timeout honestly', async () => {
    const { script, cwd } = await writeStub('hang');
    const result = await runAcpAgent(
      {
        command: process.execPath,
        args: [script],
        cwd,
        idleTimeoutMs: 1_000,
        wallClockMs: 30_000,
        killGraceMs: 1_000,
      },
      'hang forever'
    );
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe('idle');
    expect(result.cancelled).toBe(true);
  }, 40_000);

  test('external cancellation kills the process tree including descendants', async () => {
    // M-118 order 4: Windows descendant cleanup. The stub spawns a
    // long-lived grandchild; after cancellation nothing from the tree may
    // survive. treeAfterKill is the proof artifact.
    const { script, cwd } = await writeStub('spawn-child');
    const cancel = createCancelController();
    setTimeout(() => cancel.cancel(), 1_500);
    const result = await runAcpAgent(
      {
        command: process.execPath,
        args: [script],
        cwd,
        idleTimeoutMs: 30_000,
        wallClockMs: 60_000,
        killGraceMs: 4_000,
      },
      'spawn and hang',
      cancel
    );
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.treeAfterKill).toEqual([]);
    if (result.agentPid !== null) {
      const survivors = await enumerateProcessTree(result.agentPid);
      expect(survivors.length).toBe(0);
    }
  }, 60_000);

  test('reports a spawn failure instead of pretending the leg ran', async () => {
    const result = await runAcpAgent(
      {
        command: 'definitely-not-a-real-binary-bdc',
        args: [],
        cwd: tmpdir(),
        idleTimeoutMs: 1_000,
        wallClockMs: 2_000,
        killGraceMs: 500,
      },
      'anything'
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toContain('spawn_failed');
  }, 20_000);
});
