/**
 * WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01, Test 14 (the agent's write authority, a stated gap).
 *
 * The rebuilt bdc-feature-development lane no longer tells the implement agent to push, but the
 * agent can still push the run worktree's own branch with the run's identity. Such a branch must
 * resolve to its originating run through the EXISTING worktree-path lookup, so the run's holds
 * apply. No source under packages/overseer changes; this pins today's behavior.
 */
import { describe, expect, test } from 'bun:test';
import {
  findOriginatingRunForPullRequest,
  type OriginatingRunCandidate,
} from '../originating-run-lookup';

const WORKTREE_BRANCH = 'archon/task-web-worker-1790865294847-n1qba8';

function candidate(overrides: Partial<OriginatingRunCandidate>): OriginatingRunCandidate {
  return {
    id: 'run-other',
    status: 'completed',
    started_at: '2026-11-26 10:00:00',
    working_path: null,
    codebase_name: null,
    codebase_url: null,
    event_data: null,
    ...overrides,
  };
}

describe('june-shape lane: a branch pushed from the run worktree links to the run (Test 14)', () => {
  test('the worktree branch resolves to the run that owns that worktree', async () => {
    const run = candidate({
      id: 'run-june-shape',
      status: 'running',
      working_path: `/.archon/worktrees/thinmansoftware/shopops/${WORKTREE_BRANCH}`,
      codebase_name: 'thinmansoftware/shopops',
    });
    const unrelated = candidate({
      id: 'run-unrelated',
      working_path: '/.archon/worktrees/thinmansoftware/shopops/archon/task-web-worker-1-zzzzzz',
      codebase_name: 'thinmansoftware/shopops',
    });
    const found = await findOriginatingRunForPullRequest(
      { owner: 'thinmansoftware', repo: 'shopops', number: 900, headRef: WORKTREE_BRANCH },
      async () => [unrelated, run]
    );
    expect(found).toEqual({ runId: 'run-june-shape', status: 'running' });
  });

  test('the same branch name in another repository does not link', async () => {
    const run = candidate({
      id: 'run-june-shape',
      working_path: `/.archon/worktrees/thinmansoftware/shopops/${WORKTREE_BRANCH}`,
      codebase_name: 'thinmansoftware/shopops',
    });
    const found = await findOriginatingRunForPullRequest(
      { owner: 'thinmansoftware', repo: 'lspro-react', number: 900, headRef: WORKTREE_BRANCH },
      async () => [run]
    );
    expect(found).toBeNull();
  });

  test('a branch name the agent chose itself is not covered (the stated gap)', async () => {
    const run = candidate({
      id: 'run-june-shape',
      working_path: `/.archon/worktrees/thinmansoftware/shopops/${WORKTREE_BRANCH}`,
      codebase_name: 'thinmansoftware/shopops',
    });
    const found = await findOriginatingRunForPullRequest(
      { owner: 'thinmansoftware', repo: 'shopops', number: 901, headRef: 'feat/agent-chosen-name' },
      async () => [run]
    );
    expect(found).toBeNull();
  });
});
