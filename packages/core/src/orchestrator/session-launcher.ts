/**
 * Session launcher -- per-session worktree isolation for interactive agent sessions.
 *
 * WO-HARNESS-SESSION-WORKTREE-ISOLATION-01. Two concurrent agent sessions must
 * never share a single mutable checkout: one session switching branches would
 * destroy the other's uncommitted working tree (the 2026-07-26 incident).
 *
 * This is a thin wrapper around the ALREADY-EXISTING isolation machinery
 * (`validateAndResolveIsolation` -> `IsolationResolver` -> `WorktreeProvider`).
 * It does NOT create worktrees itself; it delegates entirely so that:
 *   - allocation keys on the stable conversation id (same session across
 *     turns/reconnects resolves to the same worktree -- no orphaning),
 *   - DB tracking of `isolation_environments` (and therefore the #488 orphan
 *     sweep) happens through the existing path with no second mechanism,
 *   - the launcher FAILS CLOSED rather than falling back to the shared primary
 *     checkout when isolation cannot be established.
 */
import { resolve as resolvePath } from 'path';
import { realpath } from 'fs/promises';
import { createLogger } from '@archon/paths';
import type { Conversation, Codebase, IPlatformAdapter } from '../types';
import { IsolationBlockedError } from '@archon/isolation';
import { validateAndResolveIsolation } from './orchestrator';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('session-launcher');
  return cachedLog;
}

/**
 * Result of a session launch attempt.
 * `refused: true` is a HARD failure -- the caller must not fall through to any
 * cwd. `message` is user-facing and always names the "primary checkout" so the
 * refusal is legible without reading a process document.
 */
export type SessionLaunchResult =
  | { refused: false; cwd: string }
  | { refused: true; message: string };

/**
 * Reduce a path to a stable filesystem identity for equality comparison.
 *
 * `resolve()` alone is a LEXICAL fold -- it collapses trailing slashes and
 * relative components but treats a symlink/junction alias, or a differently
 * cased spelling on a case-insensitive filesystem, as a distinct path. Either
 * would make the primary checkout compare UNEQUAL to a resolved cwd that is
 * really the same directory, defeating the Case B invariant and letting a
 * session run in the shared clone.
 *
 * So we canonicalize with `realpath` first (expands symlinks, junctions, and
 * Windows 8.3 short names), then `resolve`, then lower-case on win32 where the
 * filesystem is case-insensitive. This mirrors `normalizeIdentity` in
 * `@archon/git`'s `verifyWorktreeOwnership`. A nonexistent path (ENOENT) falls
 * back to the lexical form; any other fs error propagates (fail closed).
 */
async function normalizePathIdentity(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw error;
    canonical = resolvePath(path);
  }
  const resolved = resolvePath(canonical);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Allocate (or reuse) a per-session worktree and return it as the session cwd.
 *
 * Keyed on `conversation.id` (workflowType `'thread'`), so a reconnecting
 * session with the same id resolves to the same worktree rather than orphaning
 * its predecessor.
 *
 * Refuses (fails closed) when isolation could not be established, or -- as a
 * defense-in-depth invariant check -- when the resolved cwd would still be the
 * shared primary checkout.
 */
export async function launchSession(
  conversation: Conversation,
  codebase: Codebase,
  platform: IPlatformAdapter,
  conversationId: string
): Promise<SessionLaunchResult> {
  let resolvedCwd: string;
  try {
    const resolution = await validateAndResolveIsolation(
      conversation,
      codebase,
      platform,
      conversationId,
      { workflowType: 'thread', workflowId: conversation.id }
    );
    resolvedCwd = resolution.cwd;
  } catch (error) {
    // Case A (reachable today): worktree creation failed. The resolver has
    // already notified the user; we translate the block into a fail-closed
    // refusal instead of letting the session run in the shared clone.
    if (error instanceof IsolationBlockedError) {
      getLog().warn(
        { conversationId, codebaseId: codebase.id, reason: error.reason },
        'session_launch_isolation_blocked'
      );
      return {
        refused: true,
        message:
          `Refusing to start this session in the primary checkout for "${codebase.name}"; ` +
          `worktree allocation failed (${error.reason ?? 'creation_failed'}). ` +
          'Resolve the underlying issue and retry -- each session must get its own worktree.',
      };
    }
    throw error;
  }

  // Case B (defense-in-depth invariant): the resolver's contract is to hand
  // back a dedicated worktree for a codebase-scoped request, never the primary
  // checkout itself. Verify that invariant rather than trusting it blindly.
  //
  // The comparison uses filesystem IDENTITY (realpath + resolve + win32 case
  // fold via normalizePathIdentity), NOT a lexical resolve(): a symlink/junction
  // alias or a case-different spelling of the primary checkout would otherwise
  // compare unequal and slip past this guard into the shared clone. We do NOT
  // use getCanonicalRepoPath, which maps a worktree back to its parent repo and
  // would false-positive on every legitimate worktree -- see PR notes for the
  // deviation from the drafted plan.
  const [resolvedIdentity, primaryIdentity] = await Promise.all([
    normalizePathIdentity(resolvedCwd),
    normalizePathIdentity(codebase.default_cwd),
  ]);
  if (resolvedIdentity === primaryIdentity) {
    getLog().error(
      { conversationId, codebaseId: codebase.id, resolvedCwd, primaryCwd: codebase.default_cwd },
      'session_launch_resolved_to_primary_checkout'
    );
    return {
      refused: true,
      message:
        `Refusing to start this session in the primary checkout at "${codebase.default_cwd}" ` +
        `for "${codebase.name}"; the launcher must allocate a dedicated per-session worktree. ` +
        'This is a safety invariant -- do not run interactive sessions in the shared clone.',
    };
  }

  getLog().info(
    { conversationId, codebaseId: codebase.id, cwd: resolvedCwd },
    'session_launch_worktree_allocated'
  );
  return { refused: false, cwd: resolvedCwd };
}
