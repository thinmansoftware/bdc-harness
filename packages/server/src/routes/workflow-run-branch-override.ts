// Atomic-dispatch branch-override parser (WO-HARNESS-ATOMIC-FIRE-FROM-BRANCH-01)
// -----------------------------------------------------------------------------
// Extracts and validates an OPTIONAL `--from <ref>` / `--from-branch <ref>`
// override from an atomic `/workflow run ...` message dispatched through
// POST /api/conversations. The advertised input is a REMOTE start ref shaped as
// `origin/<branch>`: the harness fetches `<branch>` from origin and pins the
// refreshed `origin/<branch>` as the new task worktree's start point.
//
// This is a pure, side-effect-free validator apart from the async
// `git check-ref-format` call it delegates to. It NEVER throws for user input --
// malformed input yields a discriminated `error` result so the route can fail
// closed (HTTP 400) BEFORE any conversation, message, run, or isolation
// environment is created. The single validated `hints` object it returns is the
// one object threaded through both pre-dispatch validation and dispatch.
//
// Existing CLI callers (`packages/cli/src/commands/workflow.ts`) are unaffected:
// they parse `--from` themselves with local-ref semantics and never call this.

import { isValidBranchName, toBranchName } from '@archon/git';
import type { HandleMessageContext } from '@archon/core';

// Derive the isolation-hints shape from the core message context rather than
// importing @archon/isolation directly (not a server dependency). Type-only, so
// this is erased at build time.
type IsolationHints = NonNullable<HandleMessageContext['isolationHints']>;

/** Flag spellings that request a start-branch override. */
const FROM_FLAGS = new Set(['--from', '--from-branch']);

/** Required shape for an atomic remote start ref: `origin/<branch>`. */
const ORIGIN_PREFIX = 'origin/';

export type BranchOverrideResult =
  /** No `--from`/`--from-branch` flag present; default isolation behavior applies. */
  | { kind: 'none' }
  /** Malformed/unsafe input -- caller must reject before creating anything. */
  | { kind: 'error'; error: string }
  /** Valid override -- `hints` is the single object used by validation + dispatch. */
  | { kind: 'ok'; hints: IsolationHints };

/**
 * Split a `--from[=value]` / `--from-branch[=value]` token into flag + inline
 * value (the `=` form). Returns null when the token is not a from-flag.
 */
function matchFromFlag(token: string): { flag: string; inlineValue?: string } | null {
  const eq = token.indexOf('=');
  if (eq !== -1) {
    const flag = token.slice(0, eq);
    if (FROM_FLAGS.has(flag)) return { flag, inlineValue: token.slice(eq + 1) };
    return null;
  }
  if (FROM_FLAGS.has(token)) return { flag: token };
  return null;
}

/**
 * Parse and validate exactly one optional remote start-branch override from an
 * atomic `/workflow run` message.
 *
 * Fails closed (returns `{ kind: 'error' }`) for: a missing value, a value that
 * looks like a flag (`-` prefix), more than one from-flag (repeated or mixed
 * aliases), a value that is not shaped `origin/<branch>` (e.g. a bare
 * `release/ce`), and a `<branch>` portion rejected by
 * `git check-ref-format --branch`.
 */
export async function parseWorkflowRunBranchOverride(
  message: string
): Promise<BranchOverrideResult> {
  const tokens = message.trim().split(/\s+/);

  let rawValue: string | undefined;
  let seenFlag: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const matched = matchFromFlag(tokens[i]);
    if (!matched) continue;

    // Reject a second from-flag (duplicate spelling or mixed aliases).
    if (seenFlag !== undefined) {
      return {
        kind: 'error',
        error: 'Multiple --from/--from-branch flags supplied; provide exactly one branch override.',
      };
    }
    seenFlag = matched.flag;

    if (matched.inlineValue !== undefined) {
      rawValue = matched.inlineValue;
    } else {
      const next = tokens[i + 1];
      // Missing value, or the next token is another flag (value swallowed).
      if (next === undefined || next.startsWith('-')) {
        return {
          kind: 'error',
          error: `${matched.flag} requires a branch value shaped "origin/<branch>".`,
        };
      }
      rawValue = next;
      i++; // consume the value token
    }
  }

  if (seenFlag === undefined) return { kind: 'none' };

  if (rawValue === undefined || rawValue === '') {
    return {
      kind: 'error',
      error: `${seenFlag} requires a branch value shaped "origin/<branch>".`,
    };
  }

  // A value that begins with "-" is treated as a missing value / option, never a ref.
  if (rawValue.startsWith('-')) {
    return {
      kind: 'error',
      error: `${seenFlag} requires a branch value shaped "origin/<branch>"; got an option-like value.`,
    };
  }

  // Atomic dispatch advertises a REMOTE start ref. A syntactically valid but
  // non-remote value such as "release/ce" is rejected on purpose.
  if (!rawValue.startsWith(ORIGIN_PREFIX) || rawValue.length <= ORIGIN_PREFIX.length) {
    return {
      kind: 'error',
      error: `${seenFlag} value "${rawValue}" must be a remote ref shaped "origin/<branch>".`,
    };
  }

  const branch = rawValue.slice(ORIGIN_PREFIX.length);
  const branchValid = await isValidBranchName(branch);
  if (!branchValid) {
    return {
      kind: 'error',
      error: `${seenFlag} branch "${branch}" is not a valid git branch name.`,
    };
  }

  return {
    kind: 'ok',
    hints: {
      workflowType: 'task',
      fromBranch: toBranchName(rawValue),
    },
  };
}
