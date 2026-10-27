import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createCodebase } from '../../packages/core/src/db/codebases';
import { closeDatabase, getDatabase, resetDatabase } from '../../packages/core/src/db/connection';
import { getDefaultWorkflowsPath } from '../../packages/paths/src/archon-paths';
import { discoverWorkflowsWithConfig } from '../../packages/workflows/src/workflow-discovery';
import { committedBlobHashes, renderHistory, renderHistoryJson } from './generate-history';
import { computeDrift, notifyServedLaneUniqueEdits, reconcileServedLanes } from './sync';
import type { DriftLane, ServedLaneHistory } from './sync';

delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;
delete process.env.DATABASE_URL;

const isolatedHome = mkdtempSync(join(tmpdir(), 'served-lanes-home-'));
const startupArchonHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = isolatedHome;
resetDatabase();

const OPERATOR_TOKEN = 'served-lanes-test-operator-token';
const NOW = new Date('2026-10-27T13:51:00.000Z');
const NOW_LATER = new Date('2026-10-27T14:05:00.000Z');
const REPO_ROOT = resolve(import.meta.dir, '../..');

function sha256Hex(bytes: Buffer | string): string {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  return createHash('sha256').update(data).digest('hex');
}

function laneYaml(description: string): string {
  return `name: lane\ndescription: ${description}\nnodes:\n  - id: note\n    prompt: Say hello.\n`;
}

function gitIn(repo: string, args: readonly string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=served-lanes@example.com',
      '-c',
      'user.name=Served Lanes',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.autocrlf=false',
      '-c',
      'safe.directory=*',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8' }
  );
}

function backupStamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

interface FileSnap {
  name: string;
  mtimeMs: number;
  sha256: string;
}

async function snapFiles(dir: string): Promise<FileSnap[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const snaps: FileSnap[] = [];
  for (const name of names) {
    const full = join(dir, name);
    const info = await stat(full);
    snaps.push({ name, mtimeMs: info.mtimeMs, sha256: sha256Hex(await readFile(full)) });
  }
  return snaps;
}

async function makeTree(): Promise<{ parent: string; volumeDir: string; bakedDir: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'served-lanes-'));
  const volumeDir = join(parent, 'workflows');
  const bakedDir = join(parent, 'baked');
  await mkdir(volumeDir);
  await mkdir(bakedDir);
  return { parent, volumeDir, bakedDir };
}

afterAll(async () => {
  if (startupArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = startupArchonHome;
  await closeDatabase();
  await rm(isolatedHome, { recursive: true, force: true });
});

describe('served lanes', () => {
  test('identical stale file is replaced with a backup', async () => {
    const { parent, volumeDir, bakedDir } = await makeTree();
    try {
      const stale = laneYaml('STALE');
      const baked = laneYaml('BAKED');
      const steady = laneYaml('SAME');
      await writeFile(join(volumeDir, 'lane.yaml'), stale);
      await writeFile(join(bakedDir, 'lane.yaml'), baked);
      await writeFile(join(volumeDir, 'steady.yaml'), steady);
      await writeFile(join(bakedDir, 'steady.yaml'), steady);
      const past = new Date('2020-01-01T00:00:00.000Z');
      await utimes(join(volumeDir, 'steady.yaml'), past, past);
      const steadyBefore = await stat(join(volumeDir, 'steady.yaml'));

      const history: ServedLaneHistory = { 'lane.yaml': [sha256Hex(stale)] };
      const lanePath = join(volumeDir, 'lane.yaml');
      await chmod(lanePath, 0o640);
      const laneBefore = await stat(lanePath);
      const result = await reconcileServedLanes({ volumeDir, bakedDir, history, now: NOW });

      expect(sha256Hex(await readFile(lanePath))).toBe(sha256Hex(baked));
      const laneAfter = await stat(lanePath);
      expect(laneAfter.ino).toBe(laneBefore.ino);
      expect(laneAfter.uid).toBe(laneBefore.uid);
      expect(laneAfter.gid).toBe(laneBefore.gid);
      expect(laneAfter.mode).toBe(laneBefore.mode);
      const backupDir = `${volumeDir}.bak-${backupStamp(NOW)}`;
      expect(result.backup_path).toBe(backupDir);
      expect(result.replaced).toEqual(['lane.yaml']);
      expect(sha256Hex(await readFile(join(backupDir, 'lane.yaml')))).toBe(sha256Hex(stale));
      const backupNames = await readdir(backupDir);
      expect(backupNames).toEqual(['lane.yaml']);
      const steadyAfter = await stat(join(volumeDir, 'steady.yaml'));
      expect(steadyAfter.mtimeMs).toBe(steadyBefore.mtimeMs);
      expect(sha256Hex(await readFile(join(volumeDir, 'steady.yaml')))).toBe(sha256Hex(steady));

      const report = JSON.parse(
        await readFile(join(parent, 'served-lanes-report.json'), 'utf8')
      ) as { replaced: string[] };
      expect(report.replaced).toEqual(['lane.yaml']);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('a unique uncommitted edit is preserved and reported', async () => {
    const { parent, volumeDir, bakedDir } = await makeTree();
    try {
      const unique = laneYaml('UNIQUE');
      const baked = laneYaml('BAKED');
      const volumePath = join(volumeDir, 'lane.yaml');
      await writeFile(volumePath, unique);
      await writeFile(join(bakedDir, 'lane.yaml'), baked);
      const before = await stat(volumePath);

      const result = await reconcileServedLanes({
        volumeDir,
        bakedDir,
        history: {},
        now: NOW,
      });

      expect(sha256Hex(await readFile(volumePath))).toBe(sha256Hex(unique));
      expect(result.backup_path).toBeNull();
      expect(result.replaced).toEqual([]);
      const parentNames = await readdir(parent);
      expect(parentNames.some(name => name.includes('.bak-'))).toBe(false);
      expect(result.unique_edit).toEqual([
        {
          filename: 'lane.yaml',
          sha256: sha256Hex(unique),
          mtime: before.mtime.toISOString(),
        },
      ]);

      const reportPath = join(parent, 'served-lanes-report.json');
      await notifyServedLaneUniqueEdits(reportPath);
      await notifyServedLaneUniqueEdits(reportPath);

      const idempotencyKey = `served-lanes:lane.yaml:${sha256Hex(unique).slice(0, 12)}`;
      const messages = await getDatabase().query<{ body: string }>(
        `SELECT body FROM agent_dispatch_messages
         WHERE recipient = $1 AND idempotency_key = $2`,
        ['xo', idempotencyKey]
      );
      expect(messages.rows.length).toBe(1);
      expect(messages.rows[0]?.body ?? '').toContain('lane.yaml');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('an edit between classify and replace is preserved', async () => {
    const { parent, volumeDir, bakedDir } = await makeTree();
    try {
      const stale = laneYaml('STALE');
      const baked = laneYaml('BAKED');
      const edited = Buffer.from(laneYaml('EDITED-BETWEEN'));
      const volumePath = join(volumeDir, 'lane.yaml');
      await writeFile(volumePath, stale);
      await writeFile(join(bakedDir, 'lane.yaml'), baked);
      const history: ServedLaneHistory = { 'lane.yaml': [sha256Hex(stale)] };
      let capturedMtime = '';

      const result = await reconcileServedLanes({
        volumeDir,
        bakedDir,
        history,
        now: NOW,
        beforeReplace: async () => {
          await writeFile(volumePath, edited);
          const info = await stat(volumePath);
          capturedMtime = info.mtime.toISOString();
        },
      });

      const liveBytes = await readFile(volumePath);
      expect(Buffer.compare(liveBytes, edited)).toBe(0);
      expect(result.replaced).toEqual([]);
      expect(result.backup_path).toBeNull();
      const parentNames = await readdir(parent);
      expect(parentNames.some(name => name.includes('.bak-'))).toBe(false);
      const uniqueEdit = {
        filename: 'lane.yaml',
        sha256: sha256Hex(edited),
        mtime: capturedMtime,
      };
      expect(result.unique_edit).toEqual([uniqueEdit]);

      const report = JSON.parse(
        await readFile(join(parent, 'served-lanes-report.json'), 'utf8')
      ) as {
        unique_edit: Array<{ filename: string; sha256: string; mtime: string }>;
      };
      expect(report.unique_edit).toEqual([uniqueEdit]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('the drift report lists the right files and writes nothing', async () => {
    const { parent, volumeDir, bakedDir } = await makeTree();
    try {
      const synced = laneYaml('SAME');
      const stale = laneYaml('STALE');
      const baked = laneYaml('BAKED');
      const unique = laneYaml('UNIQUE');
      const onlyVolume = laneYaml('VOLUME');
      const onlyBaked = laneYaml('MISSING');
      await writeFile(join(volumeDir, 'in-sync.yaml'), synced);
      await writeFile(join(bakedDir, 'in-sync.yaml'), synced);
      await writeFile(join(volumeDir, 'stale.yaml'), stale);
      await writeFile(join(bakedDir, 'stale.yaml'), baked);
      await writeFile(join(volumeDir, 'unique.yaml'), unique);
      await writeFile(join(bakedDir, 'unique.yaml'), baked);
      await writeFile(join(volumeDir, 'volume-only.yaml'), onlyVolume);
      await writeFile(join(bakedDir, 'missing.yaml'), onlyBaked);

      const history: ServedLaneHistory = { 'stale.yaml': [sha256Hex(stale)] };
      const volumeBefore = await snapFiles(volumeDir);
      const bakedBefore = await snapFiles(bakedDir);
      const parentBefore = (await readdir(parent)).sort();

      const drift = await computeDrift({ volumeDir, bakedDir, history });

      expect(drift.lanes).toEqual([
        {
          filename: 'in-sync.yaml',
          state: 'in_sync',
          served_sha256: sha256Hex(synced),
          baked_sha256: sha256Hex(synced),
        },
        {
          filename: 'missing.yaml',
          state: 'missing_in_volume',
          served_sha256: null,
          baked_sha256: sha256Hex(onlyBaked),
        },
        {
          filename: 'stale.yaml',
          state: 'stale_replaceable',
          served_sha256: sha256Hex(stale),
          baked_sha256: sha256Hex(baked),
        },
        {
          filename: 'unique.yaml',
          state: 'unique_edit',
          served_sha256: sha256Hex(unique),
          baked_sha256: sha256Hex(baked),
        },
        {
          filename: 'volume-only.yaml',
          state: 'volume_only',
          served_sha256: sha256Hex(onlyVolume),
          baked_sha256: null,
        },
      ]);
      expect(await snapFiles(volumeDir)).toEqual(volumeBefore);
      expect(await snapFiles(bakedDir)).toEqual(bakedBefore);
      expect((await readdir(parent)).sort()).toEqual(parentBefore);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('a missing volume is empty drift, not an error', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'served-lanes-missing-volume-'));
    const volumeDir = join(parent, 'absent-workflows');
    const bakedDir = join(parent, 'baked');
    const emptyHome = await mkdtemp(join(tmpdir(), 'served-lanes-empty-home-'));
    const previousHome = process.env.ARCHON_HOME;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    const previousAccessHosts = process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
    const previousEmails = process.env.ARCHON_OPERATOR_EMAILS;
    try {
      await mkdir(bakedDir);
      const baked = laneYaml('MISSING-VOLUME');
      await writeFile(join(bakedDir, 'lane.yaml'), baked);
      const bakedBefore = await snapFiles(bakedDir);

      const drift = await computeDrift({ volumeDir, bakedDir, history: {} });
      expect(drift.lanes).toEqual([
        {
          filename: 'lane.yaml',
          state: 'missing_in_volume',
          served_sha256: null,
          baked_sha256: sha256Hex(baked),
        },
      ]);
      expect(await snapFiles(bakedDir)).toEqual(bakedBefore);
      await expect(stat(volumeDir)).rejects.toThrow();

      const bakedNames = (await readdir(getDefaultWorkflowsPath(), { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
        .map(entry => entry.name)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnv[key] = value;
      }
      childEnv.ARCHON_HOME = emptyHome;
      const driftProc = Bun.spawn({
        cmd: ['bun', 'run', 'scripts/served-lanes/cli.ts', '--drift'],
        cwd: REPO_ROOT,
        env: childEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const driftCode = await driftProc.exited;
      const driftOut = await new Response(driftProc.stdout).text();
      const driftErr = await new Response(driftProc.stderr).text();
      expect(driftCode, `${driftErr}\n${driftOut}`).toBe(0);
      const cliBody = JSON.parse(driftOut) as { lanes: DriftLane[] };
      expect(cliBody.lanes.map(lane => lane.filename)).toEqual(bakedNames);
      expect(new Set(cliBody.lanes.map(lane => lane.filename)).size).toBe(cliBody.lanes.length);
      for (const lane of cliBody.lanes) {
        expect(lane.state).toBe('missing_in_volume');
        expect(lane.served_sha256).toBeNull();
        expect(lane.baked_sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      await expect(stat(join(emptyHome, 'workflows'))).rejects.toThrow();
      await expect(stat(join(emptyHome, 'served-lanes-report.json'))).rejects.toThrow();

      process.env.ARCHON_HOME = emptyHome;
      process.env.NODE_ENV = 'production';
      process.env.ARCHON_OPERATOR_TOKEN = OPERATOR_TOKEN;
      process.env.TASKMASTER_INTERVAL_MS = '0';
      process.env.TASKMASTER_DEADMAN_INTERVAL_MS = '0';
      process.env.INBOX_READER_INTERVAL_MS = '0';
      process.env.OPERATOR_INBOX_INTERVAL_MS = '0';
      process.env.INBOX_READER_OPERATOR_OWNER = 'reader';

      const { validationErrorHook } =
        await import('../../packages/server/src/routes/openapi-defaults');
      const apiFile = resolve(import.meta.dir, '../../packages/server/src/routes/api.ts');
      const honoPath = Bun.resolveSync('@hono/zod-openapi', apiFile);
      const { OpenAPIHono } = await import(honoPath);
      const { registerApiRoutes } = await import('../../packages/server/src/routes/api');
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, {} as never, {} as never);

      const response = await app.request('/api/served-lanes/drift', {
        headers: { 'x-archon-operator-token': OPERATOR_TOKEN },
      });
      expect(response.status).toBe(200);
      const apiBody = (await response.json()) as { lanes: DriftLane[] };
      expect(apiBody.lanes).toEqual(cliBody.lanes);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
      else process.env.ARCHON_OPERATOR_TOKEN = previousToken;
      if (previousAccessHosts === undefined) delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
      else process.env.ARCHON_OPERATOR_ACCESS_HOSTS = previousAccessHosts;
      if (previousEmails === undefined) delete process.env.ARCHON_OPERATOR_EMAILS;
      else process.env.ARCHON_OPERATOR_EMAILS = previousEmails;
      delete process.env.TASKMASTER_INTERVAL_MS;
      delete process.env.TASKMASTER_DEADMAN_INTERVAL_MS;
      delete process.env.INBOX_READER_INTERVAL_MS;
      delete process.env.OPERATOR_INBOX_INTERVAL_MS;
      delete process.env.INBOX_READER_OPERATOR_OWNER;
      await rm(parent, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('restart is not required for discovery', async () => {
    const savedHome = process.env.ARCHON_HOME;
    const home = await mkdtemp(join(tmpdir(), 'served-lanes-discover-'));
    const cwd = await mkdtemp(join(tmpdir(), 'served-lanes-cwd-'));
    const bakedDir = await mkdtemp(join(tmpdir(), 'served-lanes-baked-'));
    try {
      const volumeDir = join(home, 'workflows');
      await mkdir(volumeDir);
      const stale = laneYaml('STALE');
      const baked = laneYaml('BAKED');
      await writeFile(join(volumeDir, 'lane.yaml'), stale);
      await writeFile(join(bakedDir, 'lane.yaml'), baked);
      process.env.ARCHON_HOME = home;

      const loadConfig = async (): Promise<{ defaults: { loadDefaultWorkflows: boolean } }> => ({
        defaults: { loadDefaultWorkflows: false },
      });
      const first = await discoverWorkflowsWithConfig(cwd, loadConfig);
      const staleWorkflow = first.workflows.find(item => item.workflow.name === 'lane');
      expect(first.errors).toEqual([]);
      expect(staleWorkflow?.source).toBe('global');
      expect(staleWorkflow?.workflow.description).toBe('STALE');

      await reconcileServedLanes({
        volumeDir,
        bakedDir,
        history: { 'lane.yaml': [sha256Hex(stale)] },
        now: NOW,
      });

      const second = await discoverWorkflowsWithConfig(cwd, loadConfig);
      const bakedWorkflow = second.workflows.find(item => item.workflow.name === 'lane');
      expect(bakedWorkflow?.source).toBe('global');
      expect(bakedWorkflow?.workflow.description).toBe('BAKED');
    } finally {
      if (savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedHome;
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await rm(bakedDir, { recursive: true, force: true });
    }
  });

  test('PUT on a bundled lane name is refused with the rebuild pointer', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.NODE_ENV = 'production';
    process.env.ARCHON_OPERATOR_TOKEN = OPERATOR_TOKEN;
    process.env.TASKMASTER_INTERVAL_MS = '0';
    process.env.TASKMASTER_DEADMAN_INTERVAL_MS = '0';
    process.env.INBOX_READER_INTERVAL_MS = '0';
    process.env.OPERATOR_INBOX_INTERVAL_MS = '0';
    process.env.INBOX_READER_OPERATOR_OWNER = 'reader';
    const projectDir = await mkdtemp(join(tmpdir(), 'served-lanes-project-'));
    const bakedAssist = join(getDefaultWorkflowsPath(), 'archon-assist.yaml');
    const bakedBefore = sha256Hex(await readFile(bakedAssist));
    try {
      await createCodebase({
        name: 'served-lanes-test',
        default_cwd: projectDir,
      });
      const { validationErrorHook } =
        await import('../../packages/server/src/routes/openapi-defaults');
      const apiFile = resolve(import.meta.dir, '../../packages/server/src/routes/api.ts');
      const honoPath = Bun.resolveSync('@hono/zod-openapi', apiFile);
      const { OpenAPIHono } = await import(honoPath);
      const { registerApiRoutes } = await import('../../packages/server/src/routes/api');
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, {} as never, {} as never);

      const definition = {
        name: 'lane',
        description: 'project copy',
        nodes: [{ id: 'note', prompt: 'Say hello.' }],
      };
      const headers = {
        'content-type': 'application/json',
        'x-archon-operator-token': OPERATOR_TOKEN,
      };

      const refused = await app.request('/api/workflows/archon-assist', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ definition }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: 'bundled_default_use_rebuild' });
      await expect(
        stat(join(projectDir, '.archon/workflows/archon-assist.yaml'))
      ).rejects.toThrow();
      expect(sha256Hex(await readFile(bakedAssist))).toBe(bakedBefore);

      const custom = await app.request(
        `/api/workflows/served-lanes-custom?cwd=${encodeURIComponent(projectDir)}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ definition: { ...definition, name: 'served-lanes-custom' } }),
        }
      );
      expect(custom.status).toBe(200);
      const customBody = (await custom.json()) as { source: string };
      expect(customBody.source).toBe('project');
      const customPath = join(projectDir, '.archon/workflows/served-lanes-custom.yaml');
      expect(await readFile(customPath, 'utf8')).toContain('served-lanes-custom');

      const projectBundled = await app.request(
        `/api/workflows/archon-assist?cwd=${encodeURIComponent(projectDir)}`,
        {
          method: 'PUT',
          headers,
          body: JSON.stringify({ definition: { ...definition, name: 'archon-assist' } }),
        }
      );
      expect(projectBundled.status).toBe(200);
      const projectBody = (await projectBundled.json()) as { source: string };
      expect(projectBody.source).toBe('project');
      expect(
        await readFile(join(projectDir, '.archon/workflows/archon-assist.yaml'), 'utf8')
      ).toContain('archon-assist');
      expect(sha256Hex(await readFile(bakedAssist))).toBe(bakedBefore);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
      else process.env.ARCHON_OPERATOR_TOKEN = previousToken;
      delete process.env.TASKMASTER_INTERVAL_MS;
      delete process.env.TASKMASTER_DEADMAN_INTERVAL_MS;
      delete process.env.INBOX_READER_INTERVAL_MS;
      delete process.env.OPERATOR_INBOX_INTERVAL_MS;
      delete process.env.INBOX_READER_OPERATOR_OWNER;
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('history manifest is deterministic and the second run is a no-op', async () => {
    const first = await renderHistory();
    const second = await renderHistory();
    expect(first).toBe(second);

    const oneHash = 'a'.repeat(64);
    expect(renderHistoryJson({ 'lane.yaml': [oneHash] })).toBe(
      `{\n  "lane.yaml": [\n    "${oneHash}"\n  ]\n}\n`
    );
    expect(first).not.toMatch(/: \["[0-9a-f]{64}"\]/);
    const parsed = JSON.parse(first) as Record<string, string[]>;
    for (const hashes of Object.values(parsed)) {
      for (const hash of hashes) {
        expect(first).toContain(`\n    "${hash}"`);
      }
    }
    const committed = await readFile(join(import.meta.dir, 'history.json'), 'utf8');
    expect(committed).toBe(first);

    const check = Bun.spawn({
      cmd: ['bun', 'run', 'scripts/served-lanes/generate-history.ts', '--check'],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const checkCode = await check.exited;
    const checkErr = await new Response(check.stderr).text();
    expect(checkCode, checkErr).toBe(0);

    const { parent, volumeDir, bakedDir } = await makeTree();
    try {
      const stale = laneYaml('STALE');
      const baked = laneYaml('BAKED');
      const steady = laneYaml('SAME');
      await writeFile(join(volumeDir, 'lane.yaml'), stale);
      await writeFile(join(bakedDir, 'lane.yaml'), baked);
      await writeFile(join(volumeDir, 'steady.yaml'), steady);
      await writeFile(join(bakedDir, 'steady.yaml'), steady);
      const history: ServedLaneHistory = { 'lane.yaml': [sha256Hex(stale)] };
      await reconcileServedLanes({ volumeDir, bakedDir, history, now: NOW });

      const laneBefore = await stat(join(volumeDir, 'lane.yaml'));
      const steadyBefore = await stat(join(volumeDir, 'steady.yaml'));
      const again = await reconcileServedLanes({
        volumeDir,
        bakedDir,
        history,
        now: NOW_LATER,
      });
      expect(again.replaced).toEqual([]);
      expect(again.unique_edit).toEqual([]);
      expect(again.backup_path).toBeNull();
      const laneAfter = await stat(join(volumeDir, 'lane.yaml'));
      const steadyAfter = await stat(join(volumeDir, 'steady.yaml'));
      expect(laneAfter.mtimeMs).toBe(laneBefore.mtimeMs);
      expect(steadyAfter.mtimeMs).toBe(steadyBefore.mtimeMs);
      expect(sha256Hex(await readFile(join(volumeDir, 'lane.yaml')))).toBe(sha256Hex(baked));
      const volumeParentNames = await readdir(parent);
      expect(volumeParentNames.some(name => name.endsWith(`.bak-${backupStamp(NOW)}`))).toBe(true);
      expect(volumeParentNames.some(name => name.endsWith(`.bak-${backupStamp(NOW_LATER)}`))).toBe(
        false
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  test('history retains a merge-side blob dropped by default simplification', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'served-lanes-git-'));
    try {
      gitIn(repo, ['init', '-b', 'main']);
      const rel = '.archon/workflows/defaults/lane.yaml';
      await mkdir(join(repo, '.archon/workflows/defaults'), { recursive: true });
      const file = join(repo, rel);
      const rootBytes = 'name: lane\nversion: root\n';
      const sideBytes = 'name: lane\nversion: side-only\n';
      const mainBytes = 'name: lane\nversion: main-only\n';
      await writeFile(file, rootBytes);
      gitIn(repo, ['add', rel]);
      gitIn(repo, ['commit', '-m', 'root']);
      gitIn(repo, ['checkout', '-b', 'side']);
      await writeFile(file, sideBytes);
      gitIn(repo, ['add', rel]);
      gitIn(repo, ['commit', '-m', 'side']);
      const sideCommit = gitIn(repo, ['rev-parse', 'HEAD']).trim();
      gitIn(repo, ['checkout', 'main']);
      await writeFile(file, mainBytes);
      gitIn(repo, ['add', rel]);
      gitIn(repo, ['commit', '-m', 'main']);
      gitIn(repo, ['merge', '-X', 'ours', '-m', 'merge side keeping main', 'side']);

      const simplified = gitIn(repo, [
        '--no-pager',
        'log',
        '--format=%H',
        '--diff-filter=AM',
        '--',
        rel,
      ])
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      expect(simplified).not.toContain(sideCommit);

      const head = gitIn(repo, ['rev-parse', 'HEAD']).trim();
      const hashes = await committedBlobHashes(rel, head, repo);
      expect(hashes).toContain(sha256Hex(rootBytes));
      expect(hashes).toContain(sha256Hex(sideBytes));
      expect(hashes).toContain(sha256Hex(mainBytes));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
