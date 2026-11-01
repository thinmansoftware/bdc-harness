import { randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REVIEWER_BROKER_UNAVAILABLE = 'reviewer_broker_unavailable';
const DEFAULT_SPOOL = '/var/lib/overseer-review';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ReviewerBrokerJob {
  readonly checkout: string;
  readonly expectedHead: string;
  readonly argv: readonly string[];
  readonly prompt?: string;
}

export interface ReviewerBrokerResult {
  readonly id: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly uid: number;
  readonly reason?: string;
  readonly outputTruncated?: boolean;
  readonly timedOut?: boolean;
}

export class ReviewerBrokerError extends Error {
  constructor(readonly reason = REVIEWER_BROKER_UNAVAILABLE) {
    super(reason);
    this.name = 'ReviewerBrokerError';
  }
}

function timeoutMs(env: Record<string, string | undefined>): number {
  const value = Number(env.OVERSEER_REVIEW_BROKER_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

export async function submitReviewerBrokerJob(
  job: ReviewerBrokerJob,
  options: { env?: Record<string, string | undefined>; id?: string } = {}
): Promise<ReviewerBrokerResult> {
  const env = options.env ?? process.env;
  const spool = env.OVERSEER_REVIEW_SPOOL?.trim() || DEFAULT_SPOOL;
  const id = options.id ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new ReviewerBrokerError();
  const ready = join(spool, 'ready');
  try {
    await access(ready);
  } catch {
    throw new ReviewerBrokerError();
  }
  const request = join(spool, `${id}.request.json`);
  const temporary = join(spool, `${id}.request.tmp`);
  const resultPath = join(spool, `${id}.result.json`);
  await writeFile(temporary, JSON.stringify({ version: 1, id, ...job, argv: [...job.argv] }), {
    mode: 0o640,
    flag: 'wx',
  });
  await rename(temporary, request);
  const deadline = Date.now() + timeoutMs(env);
  try {
    while (Date.now() < deadline) {
      try {
        const value = JSON.parse(await readFile(resultPath, 'utf8')) as ReviewerBrokerResult;
        if (
          value.id !== id ||
          typeof value.ok !== 'boolean' ||
          typeof value.exitCode !== 'number' ||
          typeof value.stdout !== 'string' ||
          typeof value.stderr !== 'string' ||
          typeof value.uid !== 'number'
        ) {
          throw new ReviewerBrokerError();
        }
        return value;
      } catch (error) {
        if (error instanceof ReviewerBrokerError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw new ReviewerBrokerError();
      }
      await Bun.sleep(25);
    }
    throw new ReviewerBrokerError();
  } finally {
    await Promise.all([
      rm(request, { force: true }),
      rm(temporary, { force: true }),
      rm(resultPath, { force: true }),
    ]);
  }
}
