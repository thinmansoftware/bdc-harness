import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IDatabase } from '@archon/core';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { acquireWoClaim, releaseWoClaim } from '@archon/core/db/cascade-wo-claims';
import { resolveAgent, loadAgentRegistry } from '@archon/workflows/agents/registry';
import { acquireAdmittedWoClaim, resolveRepoWipCap } from './fire-admission';

const REPO = 'thinmansoftware/bdc-harness';
const PROJECT = 'bdc-harness';
const NOW = '2026-11-28T12:00:00.000Z';
const BRANCH = 'repair/existing';
let db: SqliteAdapter;
let directory: string;

const pull = (number: number, draft = false, branch = `feature/${number}`, repo = REPO) => ({
  number,
  draft,
  state: 'open',
  head: { ref: branch, repo: { full_name: repo } },
});

const evidence =
  (pulls: unknown[] = [], refs: unknown[] = []) =>
  async (url: string) =>
    Response.json(url.includes('/pulls?') ? pulls : refs);

function admit(options: Partial<Parameters<typeof acquireAdmittedWoClaim>[0]> = {}) {
  return acquireAdmittedWoClaim({
    db,
    env: {},
    target: { repo: REPO },
    project: PROJECT,
    woId: 'WO-NEW-01',
    cascadeId: 'cascade-new',
    holder: 'taskmaster',
    now: NOW,
    readGitHub: evidence(),
    ...options,
  });
}

function seedClaim(woId = 'WO-OLD-01', project = PROJECT) {
  return acquireWoClaim({ woId, project, cascadeId: 'cascade-old', holder: 't3', now: NOW }, db);
}

async function seedRun(id: string, woId: string, branch: string) {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
      (id, workflow_name, conversation_id, codebase_id, status, user_message)
     VALUES ($1, 'fixture', 'conversation', 'codebase', 'running', $2)`,
    [id, `WO_ID=${woId}`]
  );
  await db.query(
    `INSERT INTO remote_agent_run_authorities (run_id, dispatch_id, wo_id, spec_source, spec_revision,
        spec_hash, workflow_name, codebase_id, canonical_remote, base_branch, base_sha, run_scope_sha,
        head_branch, worktree_path, workflow_revision, bundle_revision, engine_revision, created_at)
     VALUES ($1, $1, $2, 'source', 'rev', 'hash', 'fixture', 'codebase', $3, 'dev', 'base', 'scope',
        $4, '/unused', 'workflow', 'bundle', 'engine', $5)`,
    [id, woId, REPO, branch, NOW]
  );
}

describe('Cauldron fire admission', () => {
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cauldron-fire-admission-'));
    db = new SqliteAdapter(join(directory, 'admission.sqlite'));
    await db.query(
      `INSERT INTO remote_agent_codebases (id, name, repository_url, default_cwd)
       VALUES ('codebase', $1, $2, $3)`,
      [REPO, `https://github.com/${REPO}.git`, directory]
    );
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('conversation', 'test', 'conversation')`
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('admits below two and ignores an unrelated draft', async () => {
    expect(await admit({ readGitHub: evidence([pull(1), pull(2, true)]) })).toMatchObject({
      acquired: true,
      claim: { target_repo: REPO, target_branch: null },
    });
  });

  test.each([2, 3])(
    'defers with clear evidence at %i open PRs and writes no claim',
    async active => {
      const pulls = Array.from({ length: active }, (_, index) => pull(index + 1));
      await expect(admit({ readGitHub: evidence(pulls) })).rejects.toMatchObject({
        reason: 'repo_wip_cap',
        details: { repo: REPO, active, cap: 2 },
      });
      expect((await db.query('SELECT wo_id FROM cascade_wo_claims')).rows).toHaveLength(0);
    }
  );

  test('supports a configured cap and fails closed on invalid cap values', async () => {
    expect(resolveRepoWipCap(undefined)).toBe(2);
    for (const value of ['0', '-1', '', '1.5', 'two', '9007199254740992']) {
      expect(() => resolveRepoWipCap(value)).toThrow('repo_wip_invalid_cap');
    }
    await expect(
      admit({ env: { CAULDRON_FIRE_REPO_WIP_CAP: '1' }, readGitHub: evidence([pull(1)]) })
    ).rejects.toMatchObject({ reason: 'repo_wip_cap', details: { cap: 1 } });
    expect(
      (
        await admit({
          env: { CAULDRON_FIRE_REPO_WIP_CAP: '3' },
          readGitHub: evidence([pull(1), pull(2)]),
        })
      ).acquired
    ).toBe(true);
  });

  test('counts a WO claim before it has a run and ignores another repository', async () => {
    await seedClaim('WO-OTHER-01', 'another-repo');
    await seedClaim();
    await expect(admit({ readGitHub: evidence([pull(1)]) })).rejects.toMatchObject({
      reason: 'repo_wip_cap',
      details: { active: 2 },
    });
  });

  test('counts a claim, its active run and its ready PR as one slot', async () => {
    await seedClaim();
    await seedRun('run-1', 'WO-OLD-01', 'feature/1');
    expect((await admit({ readGitHub: evidence([pull(1)]) })).acquired).toBe(true);
  });

  test('counts an active run with only a draft; a fork branch cannot cover it', async () => {
    await seedRun('run-1', 'WO-OLD-01', 'feature/1');
    await expect(admit({ readGitHub: evidence([pull(1, true), pull(2)]) })).rejects.toMatchObject({
      reason: 'repo_wip_cap',
      details: { active: 2 },
    });
    await expect(
      admit({ readGitHub: evidence([pull(1, false, 'feature/1', 'fork/bdc-harness')]) })
    ).rejects.toMatchObject({ reason: 'repo_wip_cap', details: { active: 2 } });
  });

  test('serializes distinct WOs competing for the last slot', async () => {
    const otherDb = new SqliteAdapter(join(directory, 'admission.sqlite'));
    try {
      const readGitHub = evidence([pull(1)]);
      const results = await Promise.allSettled([
        admit({ readGitHub }),
        admit({
          db: otherDb,
          readGitHub,
          woId: 'WO-NEW-02',
          cascadeId: 'cascade-other',
          holder: 't3',
        }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find(result => result.status === 'rejected')).toMatchObject({
        reason: { reason: 'repo_wip_cap' },
      });
      expect((await db.query('SELECT wo_id FROM cascade_wo_claims')).rows).toHaveLength(1);
    } finally {
      await otherDb.close();
    }
  });

  test.each(['pull', 'branch'] as const)(
    'refreshes a stale %s read when a concurrent SQLite fire commits first',
    async kind => {
      const branch = kind === 'branch' ? BRANCH : undefined;
      if (branch) execFileSync('git', ['init', '--initial-branch', 'dev', directory]);
      const otherDb = new SqliteAdapter(join(directory, 'admission.sqlite'));
      const snapshotTaken = Promise.withResolvers<void>();
      const finishRead = Promise.withResolvers<void>();
      let remoteChanged = false;
      const readGitHub = async (url: string) => {
        const isPullRead = url.includes('/pulls?');
        if (remoteChanged) {
          return evidence(
            branch ? [] : [pull(1)],
            branch ? [{ ref: `refs/heads/${branch}` }] : []
          )(url);
        }
        if (isPullRead === !branch) {
          snapshotTaken.resolve();
          await finishRead.promise;
        }
        return Response.json([]);
      };
      const pending = admit({ target: { repo: REPO, branch }, readGitHub }).catch(
        (error: unknown) => error
      );
      try {
        await Promise.race([snapshotTaken.promise, pending]);
        const first = await admit({
          db: otherDb,
          woId: 'WO-NEW-02',
          cascadeId: 'cascade-other',
        });
        expect(first.acquired).toBe(true);
        remoteChanged = true;
        finishRead.resolve();
        expect(await pending).toMatchObject(
          branch
            ? { reason: 'target_branch_unreclaimable', details: { branch } }
            : { reason: 'repo_wip_cap', details: { active: 2, cap: 2 } }
        );
        expect((await db.query('SELECT wo_id FROM cascade_wo_claims')).rows).toEqual([
          { wo_id: 'WO-NEW-02' },
        ]);
      } finally {
        finishRead.resolve();
        await pending;
        await otherDb.close();
      }
    }
  );

  test.each(['pull', 'branch'] as const)(
    'checks GitHub for a %s that appears while waiting for the Postgres advisory lock',
    async kind => {
      const branch = kind === 'branch' ? BRANCH : undefined;
      if (branch) execFileSync('git', ['init', '--initial-branch', 'dev', directory]);
      else await seedClaim();
      let lockAcquired = false;
      const postgres: IDatabase = {
        dialect: 'postgres',
        sql: db.sql,
        query: db.query.bind(db),
        close: db.close.bind(db),
        withTransaction: fn =>
          db.withTransaction(query =>
            fn((sql, params) => {
              if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
                expect(params).toEqual([`cauldron-wip:${REPO}`]);
                lockAcquired = true;
                return Promise.resolve({ rows: [], rowCount: 0 });
              }
              return query(sql, params);
            })
          ),
      };
      const readGitHub = (url: string) =>
        evidence(
          lockAcquired && !branch ? [pull(1)] : [],
          lockAcquired && branch ? [{ ref: `refs/heads/${branch}` }] : []
        )(url);
      await expect(
        admit({ db: postgres, target: { repo: REPO, branch }, readGitHub })
      ).rejects.toMatchObject(
        branch
          ? { reason: 'target_branch_unreclaimable', details: { branch } }
          : { reason: 'repo_wip_cap', details: { active: 2, cap: 2 } }
      );
      expect((await db.query('SELECT wo_id FROM cascade_wo_claims')).rows).toHaveLength(
        branch ? 0 : 1
      );
    }
  );

  test('preserves WO claim idempotency without firing a competing cascade', async () => {
    await seedClaim('WO-NEW-01');
    const readGitHub = async () => {
      throw new Error('must not read GitHub');
    };
    expect((await admit({ readGitHub, cascadeId: 'cascade-old' })).acquired).toBe(true);
    expect(await admit({ readGitHub })).toMatchObject({
      acquired: false,
      claim: { cascade_id: 'cascade-old' },
    });
  });

  test('refuses an open target branch even when its PR is a draft', async () => {
    await expect(
      admit({
        target: { repo: REPO, branch: BRANCH },
        readGitHub: evidence([pull(1, true, BRANCH)]),
      })
    ).rejects.toMatchObject({ reason: 'target_branch_open', details: { branch: BRANCH } });
  });

  test('refuses a locally checked-out branch, a live run branch, or an existing remote ref', async () => {
    execFileSync('git', ['init', '--initial-branch', 'dev', directory]);
    execFileSync('git', [
      '-C',
      directory,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    await expect(admit({ target: { repo: REPO, branch: 'dev' } })).rejects.toMatchObject({
      reason: 'target_branch_held',
      details: { branch: 'dev' },
    });
    execFileSync('git', ['-C', directory, 'branch', 'local-existing']);
    await expect(admit({ target: { repo: REPO, branch: 'local-existing' } })).rejects.toMatchObject(
      {
        reason: 'target_branch_unreclaimable',
        details: { branch: 'local-existing' },
      }
    );
    await seedRun('run-1', 'WO-OLD-01', 'active-branch');
    await expect(admit({ target: { repo: REPO, branch: 'active-branch' } })).rejects.toMatchObject({
      reason: 'target_branch_held',
      details: { branch: 'active-branch' },
    });
    await expect(
      admit({
        target: { repo: REPO, branch: BRANCH },
        readGitHub: evidence([], [{ ref: `refs/heads/${BRANCH}` }]),
      })
    ).rejects.toMatchObject({ reason: 'target_branch_unreclaimable', details: { branch: BRANCH } });
  });

  test('holds an admitted branch for distinct WOs before GitHub or any run sees it', async () => {
    execFileSync('git', ['init', '--initial-branch', 'dev', directory]);
    const target = { repo: REPO, branch: BRANCH };
    expect((await admit({ target })).claim?.target_branch).toBe(BRANCH);
    await expect(
      admit({ target, woId: 'WO-NEW-02', cascadeId: 'cascade-other' })
    ).rejects.toMatchObject({ reason: 'target_branch_held', details: { branch: BRANCH } });
  });

  test('defers if a claim is released while the PR snapshot is in flight', async () => {
    await seedClaim();
    const otherDb = new SqliteAdapter(join(directory, 'admission.sqlite'));
    try {
      const readGitHub = async () => {
        await releaseWoClaim({ woId: 'WO-OLD-01', cascadeId: 'cascade-old', now: NOW }, otherDb);
        return Response.json([]);
      };
      await expect(admit({ readGitHub })).rejects.toMatchObject({ reason: 'repo_wip_changed' });
      expect((await admit()).acquired).toBe(true);
    } finally {
      await otherDb.close();
    }
  });

  test('rejects missing or malformed evidence and an unbound repository', async () => {
    for (const readGitHub of [
      async () => new Response(null, { status: 403 }),
      async () => Response.json({ items: [] }),
      evidence([{ ...pull(1), head: { ref: 'branch' } }]),
      evidence([{ ...pull(1), draft: undefined }]),
      evidence([pull(1), pull(1)]),
    ]) {
      await expect(admit({ readGitHub })).rejects.toMatchObject({ reason: 'repo_wip_unavailable' });
    }
    await expect(admit({ target: { repo: 'someone/else' } })).rejects.toMatchObject({
      reason: 'repo_wip_unavailable',
    });
    expect((await db.query('SELECT wo_id FROM cascade_wo_claims')).rows).toHaveLength(0);
  });

  test('checks later PR pages before admitting', async () => {
    const readGitHub = async (url: string) =>
      new URL(url).searchParams.get('page') === '1'
        ? Response.json([pull(1)], {
            headers: { link: '<https://api.github.com/example>; rel="next"' },
          })
        : Response.json([pull(2)]);
    await expect(admit({ readGitHub })).rejects.toMatchObject({
      reason: 'repo_wip_cap',
      details: { active: 2 },
    });
  });
});

test('Taskmaster persona loads in the Archon registry', async () => {
  const registry = await loadAgentRegistry(join(import.meta.dir, '../../../../.archon/agents'));
  expect(resolveAgent('taskmaster', registry)).toMatchObject({
    name: 'taskmaster',
    tools: expect.arrayContaining(['mcp', 'Task']),
  });
});
