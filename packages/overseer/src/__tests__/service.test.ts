import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { closeDatabase, resetDatabase } from '@archon/core/db';
import { listMessages } from '@archon/core/db/dispatch';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { createDispatchMessageBodySchema } from '../../../server/src/routes/schemas/dispatch.schemas.ts';
import { buildDispatchRunReportBody, runEscalation } from '../escalate.ts';
import { runOverseerService } from '../service.ts';

const oldFetch = globalThis.fetch;
const oldArchonHome = process.env.ARCHON_HOME;
const oldArchonDocker = process.env.ARCHON_DOCKER;
const oldWorkspacePath = process.env.WORKSPACE_PATH;
const oldEnabled = process.env.OVERSEER_ENABLED;
const oldDryRun = process.env.OVERSEER_DRY_RUN;

describe('service', () => {
  beforeEach(() => {
    process.env.NOTION_API_KEY = '';
    process.env.ARCHON_DOCKER = 'false';
    process.env.WORKSPACE_PATH = '';
    globalThis.fetch = mock(async () => new Response('ok', { status: 200 })) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = oldFetch;
    process.env.ARCHON_HOME = oldArchonHome;
    process.env.ARCHON_DOCKER = oldArchonDocker;
    process.env.WORKSPACE_PATH = oldWorkspacePath;
    process.env.OVERSEER_ENABLED = oldEnabled;
    process.env.OVERSEER_DRY_RUN = oldDryRun;
    await closeDatabase();
    resetDatabase();
  });

  test('OVERSEER_ENABLED unset exits with no db reads', async () => {
    delete process.env.OVERSEER_ENABLED;
    const listRunsForWatch = mock(async () => []);
    await runOverseerService({
      once: true,
      deps: {
        listRunsForWatch,
        listRunEvents: async () => [],
        findPullRequest: async () => ({
          exists: false,
          state: 'missing',
          checks: { total: 0, passed: 0, failed: 0, pending: 0 },
          mergeable: null,
        }),
        mergePullRequest: async () => ({ merged: false }),
        insertOverseerAction: async () => undefined,
      },
    });
    expect(listRunsForWatch).not.toHaveBeenCalled();
  });

  test('OVERSEER_DRY_RUN logs decision and makes zero side-effect calls', async () => {
    const insertOverseerAction = mock(async () => undefined);
    const mergePullRequest = mock(async () => ({ merged: true }));
    const lines: string[] = [];
    const oldLog = console.log;
    console.log = (line?: unknown) => {
      lines.push(String(line));
    };
    try {
      await runOverseerService({
        once: true,
        enabled: true,
        dryRun: true,
        deps: {
          listRunsForWatch: async () => [
            {
              id: 'run-dry',
              woId: 'WO-DRY-01',
              owner: 'bluedevilcollectibles',
              repo: 'bdc-harness',
              status: 'failed',
              headBranch: 'wo/dry',
            },
          ],
          listRunEvents: async () => [],
          findPullRequest: async () => ({
            exists: true,
            state: 'open',
            checks: { total: 1, passed: 1, failed: 0, pending: 0 },
            mergeable: true,
            pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 3 },
          }),
          mergePullRequest,
          insertOverseerAction,
        },
      });
    } finally {
      console.log = oldLog;
    }

    expect(JSON.parse(lines[0])).toEqual(
      expect.objectContaining({
        runId: 'run-dry',
        class: 'tail_node_false_fail',
        action: 'dry_run',
      })
    );
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).not.toHaveBeenCalled();
  });

  test('non-tail failure writes schema-valid guarded dispatch run_report', async () => {
    const body = buildDispatchRunReportBody(
      { errorClass: 'validator_rejected', woId: 'WO-RPT-01', nodeId: 'gate' },
      { decision: 'escalate', reason: 'gate rejected' },
      'run-report-1',
      '2026-07-12T00:00:00.000Z'
    );
    const envelope = {
      correlation_id: 'run-report-1',
      idempotency_key: 'overseer:run_report:run-report-1:validator_rejected',
      task_type: 'run_report',
      sender: 'overseer',
      recipient: 'operator',
      body,
    };
    expect(createDispatchMessageBodySchema.parse(envelope)).toEqual(envelope);
    expect(assessDispatchMessageBody('run_report', body)).toEqual({ allowed: true });

    const archonHome = join(
      import.meta.dir,
      `.archon-service-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(archonHome, { recursive: true });
    process.env.ARCHON_HOME = archonHome;
    await runEscalation(
      'run-report-1',
      { decision: 'escalate', reason: 'gate rejected' },
      { errorClass: 'validator_rejected', woId: 'WO-RPT-01', nodeId: 'gate' }
    );

    const messages = await listMessages({ recipient: 'operator', status: 'queued' });
    expect(messages).toHaveLength(1);
    expect(messages[0].task_type).toBe('run_report');
    expect(JSON.parse(messages[0].body)).toEqual(
      expect.objectContaining({ runId: 'run-report-1', class: 'validator_rejected' })
    );
    await closeDatabase();
    resetDatabase();
    rmSync(archonHome, { recursive: true, force: true });
  });

  test('silent dead-end writes escalation.json with unknown class', async () => {
    const archonHome = join(
      import.meta.dir,
      `.archon-escalation-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(archonHome, { recursive: true });
    process.env.ARCHON_HOME = archonHome;

    await runEscalation(
      'run-unknown',
      { decision: 'escalate', reason: 'unknown exit 1' },
      { errorClass: 'unknown', woId: 'WO-UNKNOWN-01' }
    );
    const raw = readFileSync(join(archonHome, 'runs', 'run-unknown', 'escalation.json'), 'utf8');
    const payload = JSON.parse(raw);
    expect(payload.runId).toBe('run-unknown');
    expect(payload.context.errorClass).toBe('unknown');
    await closeDatabase();
    resetDatabase();
    rmSync(archonHome, { recursive: true, force: true });
  });
});
