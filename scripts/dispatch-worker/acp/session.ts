/**
 * AcpAgentRunner -- one Dispatch-owned ACP session against one agent process.
 *
 * WO-HARNESS-ACP-DISPATCH-SLICE-01 (M-118 ruling): Dispatch is the client,
 * router, and durable record; ACP carries each live Dispatch-to-agent
 * session. This module owns exactly one leg:
 *
 *   spawn agent process -> initialize -> (authenticate) -> session/new ->
 *   session/prompt -> stream updates -> honest result
 *
 * Reliability contract (ruling order 4, all enforced here):
 *  - idle timeout: no session/update for idleTimeoutMs -> cancel
 *  - wall-clock timeout: total run > wallClockMs -> cancel
 *  - bounded cancellation: session/cancel first, then kill the process TREE
 *    after killGraceMs (Windows descendants included)
 *  - honest completion: ok=true requires stopReason 'end_turn' AND non-empty
 *    output; transport success alone is never completion
 *  - durable receipt: every session/update is captured for the transcript
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { enumerateProcessTree, killProcessTree, waitForTreeDeath } from './kill-tree';

export interface AcpRunConfig {
  command: string;
  args: string[];
  cwd: string;
  /** ACP authMethodId to send in `authenticate`; omit to skip the call. */
  authMethodId?: string;
  idleTimeoutMs: number;
  wallClockMs: number;
  killGraceMs: number;
  env?: Record<string, string>;
}

export interface AcpRunResult {
  ok: boolean;
  /** 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | ... per ACP schema */
  stopReason: string | null;
  finalText: string;
  /** Every session/update notification received, in order (durable receipt). */
  updates: unknown[];
  timedOut: 'idle' | 'wall' | null;
  cancelled: boolean;
  exitCode: number | null;
  agentPid: number | null;
  /** Pids observed in the process tree at cancellation time (before kill). */
  treeBeforeKill: number[];
  /** Pids still alive after kill+grace -- MUST be empty for a clean proof. */
  treeAfterKill: number[];
  durationMs: number;
  error?: string;
}

interface CancelController {
  cancelled: boolean;
  cancel: () => void;
}

/**
 * Stringifies a non-Error throw without falling back to '[object Object]',
 * so a rejected JSON-RPC payload lands in the transcript readably.
 */
function safeStringifyError(error: unknown): string {
  if (error === null || error === undefined) return 'acp_failed';
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'acp_failed';
  }
}

export function createCancelController(): CancelController {
  const controller: CancelController = {
    cancelled: false,
    cancel: () => {
      controller.cancelled = true;
    },
  };
  return controller;
}

export async function runAcpAgent(
  config: AcpRunConfig,
  prompt: string,
  external?: CancelController
): Promise<AcpRunResult> {
  const startedAt = Date.now();
  const updates: unknown[] = [];
  let finalText = '';
  let stopReason: string | null = null;
  let timedOut: 'idle' | 'wall' | null = null;
  let cancelled = false;
  let errorMessage: string | undefined;
  let treeBeforeKill: number[] = [];
  let treeAfterKill: number[] = [];

  const child: ChildProcess = spawn(config.command, config.args, {
    cwd: config.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    env: { ...process.env, ...(config.env ?? {}) },
  });
  const agentPid = child.pid ?? null;

  let stderrTail = '';
  child.stderr?.on('data', chunk => {
    stderrTail = (stderrTail + String(chunk)).slice(-4000);
  });

  const spawnError = await new Promise<string | null>(resolve => {
    child.once('spawn', () => {
      resolve(null);
    });
    child.once('error', err => {
      resolve(err instanceof Error ? err.message : String(err));
    });
  });
  if (spawnError !== null || !child.stdout || !child.stdin) {
    return {
      ok: false,
      stopReason: null,
      finalText: '',
      updates,
      timedOut: null,
      cancelled: false,
      exitCode: null,
      agentPid,
      treeBeforeKill: [],
      treeAfterKill: [],
      durationMs: Date.now() - startedAt,
      error: `spawn_failed: ${spawnError ?? 'no stdio'}`,
    };
  }

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  );

  const exited = new Promise<number | null>(resolve => {
    child.once('close', code => {
      resolve(code);
    });
  });

  // Auto-reject agent permission requests: this worker leg is a read-oriented
  // dispatch seat, not an autonomous editor. Choosing the first reject-kind
  // option (or cancelled outcome) fails CLOSED; agents that need writes must
  // come through a lane that grants them explicitly.
  const app = client({ name: 'bdc-dispatch-worker' }).onRequest(
    'session/request_permission',
    async ctx => {
      const options: PermissionOption[] = ctx.params.options ?? [];
      const reject = options.find(option => option.kind === 'reject_once') ?? options[0];
      if (!reject) {
        return { outcome: { outcome: 'cancelled' } } as RequestPermissionResponse;
      }
      return {
        outcome: { outcome: 'selected', optionId: reject.optionId },
      } as RequestPermissionResponse;
    }
  );

  // Idempotent process-tree kill (WO-HARNESS-ACP-KILL-EVIDENCE-FIX-01):
  // the first invocation enumerates the tree that actually existed at kill
  // time and records it in treeBeforeKill/treeAfterKill. The grace-timer path
  // and the post-connect cleanup guard both call this, and killProcessTree
  // uses taskkill/process.kill (never child.kill), so child.killed stays false
  // and a signal death leaves exitCode null -- the post-connect guard would
  // therefore fire a SECOND time against an already-dead pid, enumerate an
  // empty tree, and clobber the evidence. Memoizing the kill promise makes any
  // call after the first a no-op that returns the in-flight/settled result, so
  // the first pass's evidence survives. The killGraceMs timing contract is
  // unchanged -- waitForTreeDeath still bounds on config.killGraceMs.
  let killPromise: Promise<void> | null = null;
  const boundedKill = (): Promise<void> => {
    // Validate BEFORE memoizing so a no-op kill can never be cached. Today this
    // guard cannot latch: agentPid is a const bound at spawn and the spawn-failure
    // path returns before this closure exists, so agentPid is always non-null here.
    // Checking first keeps that true if agentPid ever becomes reassignable
    // (re-spawn / reconnect), where memoizing first would permanently cache a
    // no-op and strand a live process tree.
    if (agentPid === null) return Promise.resolve();
    if (killPromise) return killPromise;
    killPromise = (async (): Promise<void> => {
      const tree = await enumerateProcessTree(agentPid);
      treeBeforeKill = tree.map(node => node.pid);
      await killProcessTree(agentPid);
      treeAfterKill = await waitForTreeDeath(treeBeforeKill, config.killGraceMs);
    })();
    return killPromise;
  };

  try {
    await app.connectWith(stream, async ctx => {
      const init = await ctx.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      if (config.authMethodId) {
        const methods = init.authMethods ?? [];
        if (methods.some(method => method.id === config.authMethodId)) {
          await ctx.request('authenticate', { methodId: config.authMethodId });
        }
      }

      const session = await ctx.buildSession(config.cwd).start();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const requestCancel = (reason: 'idle' | 'wall' | 'external'): void => {
        if (cancelled) return;
        cancelled = true;
        if (reason !== 'external') timedOut = reason;
        void ctx.notify('session/cancel', { sessionId: session.sessionId }).catch(() => {
          /* agent may already be gone; bounded kill below is the backstop */
        });
        // Grace period for the agent to honor session/cancel, then tree-kill.
        setTimeout(() => {
          void boundedKill();
        }, config.killGraceMs).unref?.();
      };

      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          requestCancel('idle');
        }, config.idleTimeoutMs);
        idleTimer.unref?.();
      };
      armIdle();
      const wallTimer = setTimeout(() => {
        requestCancel('wall');
      }, config.wallClockMs);
      wallTimer.unref?.();
      const externalPoll = setInterval(() => {
        if (external?.cancelled) requestCancel('external');
      }, 250);
      externalPoll.unref?.();

      const promptDone = session.prompt(prompt).then(
        response => ({ kind: 'response' as const, response }),
        error => ({ kind: 'error' as const, error })
      );

      try {
        // Drain updates until the prompt turn completes; every update both
        // feeds the receipt and resets the idle timer.
        let draining = true;
        while (draining) {
          const next = await Promise.race([
            session.nextUpdate().then(update => ({ kind: 'update' as const, update })),
            promptDone,
          ]);
          if (next.kind === 'update') {
            armIdle();
            updates.push(next.update);
            const update = next.update as { update?: SessionUpdate; stop?: unknown };
            const payload = (update.update ?? update) as SessionUpdate & {
              sessionUpdate?: string;
              content?: { type?: string; text?: string };
            };
            if (
              payload?.sessionUpdate === 'agent_message_chunk' &&
              payload.content?.type === 'text' &&
              typeof payload.content.text === 'string'
            ) {
              finalText += payload.content.text;
            }
            const stop = (next.update as { stop?: { stopReason?: string } }).stop;
            if (stop?.stopReason) {
              stopReason = stop.stopReason;
              draining = false;
            }
          } else if (next.kind === 'response') {
            stopReason = next.response.stopReason ?? stopReason;
            draining = false;
          } else {
            errorMessage = next.error instanceof Error ? next.error.message : String(next.error);
            draining = false;
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(wallTimer);
        clearInterval(externalPoll);
        session.dispose();
      }
    });
  } catch (error) {
    errorMessage =
      errorMessage ?? (error instanceof Error ? error.message : safeStringifyError(error));
  }

  // Connection closed (or errored): make sure the process is actually gone.
  if (child.exitCode === null && !child.killed) {
    await boundedKill();
  }
  const exitCode = await Promise.race([
    exited,
    new Promise<number | null>(resolve =>
      setTimeout(() => {
        resolve(child.exitCode);
      }, config.killGraceMs + 1000)
    ),
  ]);

  const trimmed = finalText.trim();
  const ok =
    !cancelled && errorMessage === undefined && stopReason === 'end_turn' && trimmed.length > 0;
  if (!ok && errorMessage === undefined && trimmed.length === 0 && stopReason === 'end_turn') {
    errorMessage = 'empty_success_exit: agent stopped cleanly but produced no output';
  }
  if (errorMessage === undefined && stderrTail && !ok && !cancelled) {
    errorMessage = `agent_stderr_tail: ${stderrTail.slice(-500)}`;
  }

  return {
    ok,
    stopReason,
    finalText,
    updates,
    timedOut,
    cancelled,
    exitCode,
    agentPid,
    treeBeforeKill,
    treeAfterKill,
    durationMs: Date.now() - startedAt,
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  };
}
