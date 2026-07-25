/**
 * Integration test for WO-HARNESS-DISPATCH-SYNC-BEFORE-RESOLVE-01:
 * the deterministic '/workflow run' dispatch path must sync the codebase
 * source clone BEFORE resolving the workflow definition, so the dispatched
 * DAG comes from the same commit the worktree will be created from.
 *
 * Spec test scenarios (Given/When/Then):
 *   1. Clone behind origin + origin adds node X to the lane YAML
 *      -> dispatched DAG contains node X and definitionHeadSha == origin tip.
 *   3. git fetch fails (remote unreachable)
 *      -> dispatch proceeds on current clone contents (fail-open) with the
 *         clone HEAD still reported as evidence.
 *
 * Uses a REAL bare origin + managed clone (real git, real discovery) and
 * mocks only the codebase DB lookup.
 *
 * NOTE: this file uses mock.module('../db/codebases') with a different
 * implementation than command-handler.test.ts -- per the repo's mock
 * isolation rules it MUST run in its own `bun test` invocation (see
 * packages/core/package.json "test" script).
 */
import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileAsync } from '@archon/git';
import { getArchonWorkspacesPath } from '@archon/paths';
import type { Conversation } from '../types';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 30000,
    env: GIT_ENV,
  });
  return stdout.trim();
}

let baseDir: string;
let originPath: string;
let scratchPath: string;
let managedClonePath: string;

const WORKFLOW_NAME = 'sync-before-resolve-test-wf';

const WORKFLOW_V1 = `name: ${WORKFLOW_NAME}
description: Integration fixture for sync-before-resolve
nodes:
  - id: first
    prompt: Say hello
`;

const WORKFLOW_V2 = `name: ${WORKFLOW_NAME}
description: Integration fixture for sync-before-resolve
nodes:
  - id: first
    prompt: Say hello
  - id: node-x
    prompt: Added on origin after the clone went stale
    depends_on:
      - first
`;

/** Write the lane YAML in the scratch clone and push to origin main */
async function pushWorkflowYaml(content: string, message: string): Promise<string> {
  const workflowDir = join(scratchPath, '.archon', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, `${WORKFLOW_NAME}.yaml`), content);
  await git(scratchPath, 'add', '-A');
  await git(scratchPath, 'commit', '-m', message);
  await git(scratchPath, 'push', 'origin', 'main');
  return git(scratchPath, 'rev-parse', 'HEAD');
}

// Mock ONLY the codebase DB lookup -- discovery, config loading, and git run
// for real against the fixture clone.
const mockCodebase = {
  id: 'codebase-sync-test',
  name: 'sync-test-repo',
  repository_url: null as string | null,
  default_cwd: '',
  commands: {},
  created_at: new Date(0),
  updated_at: new Date(0),
};
const mockGetCodebase = mock(() => Promise.resolve(mockCodebase));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

const { handleCommand } = await import('./command-handler');

function makeConversation(): Conversation {
  return {
    id: 'conv-sync-test',
    platform_type: 'web',
    platform_conversation_id: 'conv-sync-test',
    codebase_id: mockCodebase.id,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), 'cmd-sync-before-resolve-'));
  originPath = join(baseDir, 'origin.git');
  scratchPath = join(baseDir, 'scratch');
  managedClonePath = join(getArchonWorkspacesPath(), 'test-owner', 'sync-test-repo', 'source');

  mkdirSync(originPath, { recursive: true });
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', originPath], {
    timeout: 30000,
    env: GIT_ENV,
  });
  await execFileAsync('git', ['clone', originPath, scratchPath], {
    timeout: 30000,
    env: GIT_ENV,
  });

  // v1 of the lane exists when the managed clone is created
  await pushWorkflowYaml(WORKFLOW_V1, 'add workflow v1');
  mkdirSync(join(managedClonePath, '..'), { recursive: true });
  await execFileAsync('git', ['clone', originPath, managedClonePath], {
    timeout: 30000,
    env: GIT_ENV,
  });
  mockCodebase.default_cwd = managedClonePath;
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(managedClonePath, { recursive: true, force: true });
});

describe('/workflow run syncs the source clone before resolving the definition', () => {
  test('scenario 1: stale clone -> dispatched DAG contains origin-added node X and definitionHeadSha == origin tip', async () => {
    // GIVEN: origin adds node X AFTER the managed clone was created
    const originTip = await pushWorkflowYaml(WORKFLOW_V2, 'add node-x on origin');
    const staleHead = await git(managedClonePath, 'rev-parse', 'HEAD');
    expect(staleHead).not.toBe(originTip); // clone is genuinely behind

    // WHEN: the deterministic run command dispatches
    const result = await handleCommand(makeConversation(), `/workflow run ${WORKFLOW_NAME}`);

    // THEN: the resolved DAG comes from post-sync HEAD (contains node X)
    expect(result.success).toBe(true);
    expect(result.workflow).toBeDefined();
    const nodeIds = result.workflow?.definition.nodes.map(n => n.id) ?? [];
    expect(nodeIds).toContain('node-x');
    // AND the definition-resolution sha recorded for the run == origin tip
    expect(result.workflow?.definitionHeadSha).toBe(originTip);
    // AND the clone itself was actually synced (resolve + worktree share one commit)
    expect(await git(managedClonePath, 'rev-parse', 'HEAD')).toBe(originTip);
  });

  test('scenario 3: fetch failure is fail-open -- dispatch proceeds on current contents with clone HEAD evidence', async () => {
    // GIVEN: the remote is unreachable
    const currentHead = await git(managedClonePath, 'rev-parse', 'HEAD');
    await git(managedClonePath, 'remote', 'set-url', 'origin', join(baseDir, 'gone.git'));

    // WHEN: dispatched
    const result = await handleCommand(makeConversation(), `/workflow run ${WORKFLOW_NAME}`);

    // THEN: run proceeds on current clone contents (not hard-failed)
    expect(result.success).toBe(true);
    expect(result.workflow).toBeDefined();
    const nodeIds = result.workflow?.definition.nodes.map(n => n.id) ?? [];
    expect(nodeIds).toContain('node-x'); // still the last-synced contents
    // AND the clone HEAD used for resolution is reported as evidence
    expect(result.workflow?.definitionHeadSha).toBe(currentHead);
  });

  test('conversation-scoped cwd (worktree path) is NOT synced -- guard restricts sync to the canonical clone', async () => {
    // GIVEN: a conversation pinned to a non-canonical cwd (simulated worktree)
    const worktreeLikePath = join(baseDir, 'scratch'); // any path != default_cwd
    const conversation: Conversation = { ...makeConversation(), cwd: worktreeLikePath };

    // WHEN: dispatched from that cwd
    const result = await handleCommand(conversation, `/workflow run ${WORKFLOW_NAME}`);

    // THEN: resolution still works from that cwd, but no clone sync ran, so no
    // definitionHeadSha is attached (the sha only means "canonical clone HEAD")
    expect(result.success).toBe(true);
    expect(result.workflow).toBeDefined();
    expect(result.workflow?.definitionHeadSha).toBeUndefined();
  });
});
