import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

export type CascadeLiveness = 'live' | 'dead' | 'unknown';

export type RunStatusResult = { readonly status: string } | { readonly notFound: true };

export type RunStatusReader = (
  runId: string,
  apiBaseUrl: string,
  token: string
) => Promise<RunStatusResult>;

export interface CascadeLivenessOptions {
  readonly outDir: string;
  readonly apiBaseUrl?: string;
  readonly token?: string;
  readonly runStatusReader?: RunStatusReader;
}

const DEAD_STATUSES = new Set([
  'completed',
  'failed',
  'escalated',
  'cancelled',
  'interrupted',
  'orphaned',
]);

async function readRunStatus(
  runId: string,
  apiBaseUrl: string,
  token: string
): Promise<RunStatusResult> {
  const response = await fetch(`${apiBaseUrl}/api/workflows/runs/${encodeURIComponent(runId)}`, {
    headers: { 'x-archon-operator-token': token },
  });
  if (response.status === 404) return { notFound: true };
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} reading run ${runId}`);
  const body = (await response.json()) as { run?: { status?: unknown } };
  if (typeof body.run?.status !== 'string') {
    throw new Error(`Malformed response reading run ${runId}`);
  }
  return { status: body.run.status };
}

export async function isCascadeLive(
  cascadeId: string,
  opts: CascadeLivenessOptions
): Promise<CascadeLiveness> {
  let entries;
  try {
    entries = await readdir(opts.outDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'dead';
    return 'unknown';
  }

  let sawUnreadableRecord = false;
  let runIds: string[] | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(opts.outDir, entry.name, 'cascade-record.json'), 'utf8');
      const record = JSON.parse(raw) as {
        cascadeId?: unknown;
        attempts?: { runId?: unknown }[];
      };
      if (record.cascadeId !== cascadeId) continue;
      if (!Array.isArray(record.attempts)) return 'unknown';
      runIds = record.attempts
        .map(attempt => attempt?.runId)
        .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') sawUnreadableRecord = true;
    }
  }

  if (runIds === null) return sawUnreadableRecord ? 'unknown' : 'dead';
  if (runIds.length === 0) return 'dead';

  const apiBaseUrl = opts.apiBaseUrl ?? process.env.ARCHON_API_BASE_URL ?? 'http://localhost:3090';
  const token = opts.token ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';
  const reader = opts.runStatusReader ?? readRunStatus;
  let sawUnknown = false;
  for (const runId of runIds) {
    try {
      const result = await reader(runId, apiBaseUrl, token);
      if ('notFound' in result) continue;
      if (!DEAD_STATUSES.has(result.status)) return 'live';
    } catch {
      sawUnknown = true;
    }
  }
  return sawUnknown ? 'unknown' : 'dead';
}
