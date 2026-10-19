import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSupervisedRun, readSupervisedBinding } from './tee-time-supervised-bootstrap';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'teetime-prepare-test-'));
  roots.push(root);
  // Loose test-only doubles deliberately permit malformed boundary rows. Real
  // schema/lifecycle behavior is checked separately by the SQLite qualification.
  const records: any = { run: null, authority: null, conversation: null, codebase: null };
  const log: string[] = [];
  const api: any = {
    getCodebase: async () => records.codebase,
    createCodebase: async (data: any) => {
      log.push('codebase');
      return (records.codebase = { ...data, id: 'codebase-1' });
    },
    getOrCreateConversation: async (_type: string, _id: string, id: string) =>
      (records.conversation = {
        id: 'conversation-1',
        codebase_id: id,
        ai_assistant_type: 'codex',
        cwd: null,
      }),
    updateConversation: async (_id: string, data: any) => Object.assign(records.conversation, data),
    getConversationById: async () => records.conversation,
    pauseWorkflowRunByOperator: async () => {
      log.push('pause');
      records.run.status = 'paused';
      records.run.metadata.paused_by = 'operator';
    },
    artifactsPath: () => join(root, 'artifacts'),
    store: {
      createWorkflowRun: async (data: any) => {
        log.push('pending');
        return (records.run = { ...data, id: 'run-1', status: 'pending' });
      },
      getWorkflowRun: async () => records.run,
      getCodebase: async () => records.codebase,
      updateWorkflowRun: async (_id: string, data: any) => {
        log.push(data.status);
        Object.assign(records.run, data);
      },
      createRunAuthority: async (data: any) => {
        log.push('authority');
        records.authority = data;
        return 'created';
      },
      getRunAuthority: async () => records.authority,
    },
  };
  let observations = 0;
  const settings: any = {
    preparationRoot: root,
    repositoryRoot: join(root, 'source'),
    worktreePath: join(root, 'worktrees', 'demo'),
    dispatchId: 'dispatch-1',
    caseHash: 'sha256:' + '1'.repeat(64),
    specSource:
      'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEETIME-SIMULATED-WALKTHROUGH-01.md',
    specRevision: 'a'.repeat(40),
    specBytes: Buffer.from('Base branch: staging\nSimulated walkthrough.\n'),
    baseSha: 'b'.repeat(40),
    runScopeSha: 'b'.repeat(40),
    headBranch: 'demo/simulated-walkthrough-01',
    observe: async () => {
      observations++;
      return {
        headCommit: 'b'.repeat(40),
        headBranch: 'demo/simulated-walkthrough-01',
        localStagingCommit: 'b'.repeat(40),
        remoteStagingCommit: 'b'.repeat(40),
      };
    },
  };
  return { root, api, settings, records, log, count: () => observations };
}
test('lifecycle adapter sequences pending, authority, running and operator pause APIs', async () => {
  const f = await fixture();
  const value = await prepareSupervisedRun(f.api, f.settings);
  expect(f.log).toEqual(['codebase', 'pending', 'authority', 'running', 'pause']);
  expect(f.records.run.status).toBe('paused');
  expect(f.records.authority.woId).toBe('WO-TEETIME-SIMULATED-WALKTHROUGH-01');
  expect(f.records.codebase.ai_assistant_type).toBe('codex');
  expect(f.records.conversation.cwd).toBe(f.settings.worktreePath);
  expect(value.runId).toBe('run-1');
  expect(f.count()).toBe(2);
  expect(await readSupervisedBinding(f.api, f.settings)).toEqual(value);
  await expect(prepareSupervisedRun(f.api, f.settings)).rejects.toThrow();
  expect(f.log.filter(item => item === 'pending')).toHaveLength(1);
});
test('readback rejects changed case, non-paused run and missing actual pause', async () => {
  const f = await fixture();
  await prepareSupervisedRun(f.api, f.settings);
  await expect(
    readSupervisedBinding(f.api, { ...f.settings, caseHash: 'sha256:' + '2'.repeat(64) })
  ).rejects.toThrow();
  f.records.run.status = 'running';
  await expect(readSupervisedBinding(f.api, f.settings)).rejects.toThrow();
  f.records.run.status = 'paused';
  f.records.run.metadata.paused_by = 'approval';
  await expect(readSupervisedBinding(f.api, f.settings)).rejects.toThrow();
});
test('moved observation fails before creating the codebase or run', async () => {
  const f = await fixture();
  f.settings.observe = async () => ({ headCommit: 'c'.repeat(40) });
  await expect(prepareSupervisedRun(f.api, f.settings)).rejects.toThrow();
  expect(f.log).toEqual([]);
});
test('foreign conversation or missing pause readback remains failed and consumed', async () => {
  const f = await fixture();
  f.api.getConversationById = async () => ({
    ...f.records.conversation,
    ai_assistant_type: 'claude',
  });
  await expect(prepareSupervisedRun(f.api, f.settings)).rejects.toThrow();
  expect(f.records.run).toBe(null);
  await expect(prepareSupervisedRun(f.api, f.settings)).rejects.toThrow();
});
