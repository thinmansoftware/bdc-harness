import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { closeDatabase, resetDatabase } from '@archon/core/db';
import { listMessages } from '@archon/core/db/dispatch';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { createDispatchMessageBodySchema } from '../../../server/src/routes/schemas/dispatch.schemas.ts';
import { buildDispatchRunReportBody, runEscalation } from '../escalate.ts';

const oldFetch = globalThis.fetch;
const oldArchonHome = process.env.ARCHON_HOME;
const oldArchonDocker = process.env.ARCHON_DOCKER;
const oldWorkspacePath = process.env.WORKSPACE_PATH;

describe.serial('escalation side effects', () => {
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
    await closeDatabase();
    resetDatabase();
  });

  test('writes a schema-valid guarded dispatch run_report', async () => {
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

    const archonHome = join(import.meta.dir, `.archon-service-${Date.now()}`);
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

  test('closes the dispatch database before Windows cleanup', async () => {
    const archonHome = join(import.meta.dir, `.archon-windows-cleanup-${Date.now()}`);
    mkdirSync(archonHome, { recursive: true });
    process.env.ARCHON_HOME = archonHome;
    await runEscalation(
      'run-windows-cleanup',
      { decision: 'escalate', reason: 'test Windows file handle cleanup' },
      { errorClass: 'validator_rejected', woId: 'WO-WINDOWS-01', nodeId: 'gate' }
    );
    const messages = await listMessages({ recipient: 'operator', status: 'queued' });
    expect(messages.some(m => m.correlation_id === 'run-windows-cleanup')).toBe(true);
    await closeDatabase();
    resetDatabase();
    expect(() => rmSync(archonHome, { recursive: true, force: true })).not.toThrow(/EBUSY|EPERM/);
  });

  test('writes escalation.json for an unknown silent dead end', async () => {
    const archonHome = join(import.meta.dir, `.archon-escalation-${Date.now()}`);
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
