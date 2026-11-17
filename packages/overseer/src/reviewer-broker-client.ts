import { FABLE_POLICY, FABLE_MODEL, closedData, type FablePermit } from './judge-transport';
import { randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyJudgeOutage } from './judge-ladder-health';

/** Only trusted code creates these entries; raw model objects never become diagnostics. */
export const TERMINATION_CLASSES = [
  'usage_limit_until',
  'usage_limit',
  'provider_credits_exhausted',
  'auth_expired',
  'unknown_nonzero',
  'unknown_error',
  'timeout',
  'broker_unavailable',
  'invalid_broker_result',
  'transport_error',
  'unsupported_binary',
  'invalid_model_output',
] as const;
export interface SanitizedTermination {
  readonly terminationClass: (typeof TERMINATION_CLASSES)[number];
  readonly exitCode: number | null;
  readonly correlationId: string;
}
const trustedDiagnostics = new WeakSet();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Internal factory, never called with model-selected identity or free-form class text. */
export function terminationDiagnostic(
  terminationClass: SanitizedTermination['terminationClass'],
  exitCode: number | null,
  correlationId: string = randomUUID()
): SanitizedTermination {
  const entry = Object.freeze({ terminationClass, exitCode, correlationId });
  if (
    !UUID.test(correlationId) ||
    !TERMINATION_CLASSES.includes(terminationClass) ||
    (exitCode !== null && !Number.isSafeInteger(exitCode))
  )
    throw new Error('invalid_diagnostic');
  trustedDiagnostics.add(entry);
  return entry;
}
export function isTrustedTermination(value: unknown): value is SanitizedTermination {
  if (!value || typeof value !== 'object' || !trustedDiagnostics.has(value)) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return (
    Object.keys(fields).sort().join(',') === 'correlationId,exitCode,terminationClass' &&
    Object.values(fields).every(field => 'value' in field)
  );
}
export function classifyBrokerTermination(
  result: ReviewerBrokerResult,
  correlationId: string
): SanitizedTermination {
  if (result.exitCode === 125) {
    const boundBroker = result.id === correlationId && result.uid === 1002 && !result.ok;
    // Pinned processJob catch: no runBrokerProcess flags or observed child exit.
    // Only the data shape matters; the private reason is never interpreted.
    const brokerCatch =
      boundBroker &&
      result.stdout === '' &&
      result.stderr === '' &&
      typeof result.reason === 'string' &&
      Object.keys(result).sort().join(',') === 'exitCode,id,ok,reason,stderr,stdout,uid';
    if (brokerCatch) return terminationDiagnostic('broker_unavailable', null, correlationId);
    const observedProcess =
      boundBroker &&
      typeof result.timedOut === 'boolean' &&
      typeof result.outputTruncated === 'boolean' &&
      (result.reason === undefined ||
        ((result.timedOut || result.outputTruncated) && typeof result.reason === 'string'));
    if (!observedProcess)
      return terminationDiagnostic('invalid_broker_result', null, correlationId);
  }
  if (result.timedOut) return terminationDiagnostic('timeout', null, correlationId);
  const exit = Number.isSafeInteger(result.exitCode) ? result.exitCode : null;
  const kind =
    exit === 0
      ? 'invalid_model_output'
      : (classifyJudgeOutage(`${result.stderr}\n${result.stdout}`)?.kind ?? 'unknown_nonzero');
  return terminationDiagnostic(kind, exit, correlationId);
}

const errorDiagnostics = new WeakMap<object, SanitizedTermination>();
export function diagnosticForError(error: unknown): SanitizedTermination | undefined {
  return error && typeof error === 'object' ? errorDiagnostics.get(error) : undefined;
}
export const REVIEWER_BROKER_UNAVAILABLE = 'reviewer_broker_unavailable';
const DEFAULT_SPOOL = '/var/lib/overseer-review';
/** Client wait for a check job: the broker's 60 s child deadline plus setup. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Extra client wait beyond a model job's own deadline (setup and result write). */
const MODEL_JOB_GRACE_MS = 60_000;

export interface ReviewerBrokerJob {
  readonly checkout: string;
  readonly expectedHead: string;
  readonly argv: readonly string[];
  readonly prompt?: string;
  /** Model jobs only: wall clock the broker enforces on the model child. */
  readonly timeoutMs?: number;
  readonly fablePermit?: FablePermit;
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
  readonly diagnostic?: SanitizedTermination;
  readonly fableEvidence?: FableExecutionEvidence;
  readonly checkPolicy?: typeof FABLE_POLICY;
}

export class ReviewerBrokerError extends Error {
  constructor(
    readonly reason = REVIEWER_BROKER_UNAVAILABLE,
    readonly diagnostic?: SanitizedTermination
  ) {
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
  const id = options.id ?? randomUUID();
  try {
    return await submitReviewerBrokerJobInternal(job, { ...options, id });
  } catch (error) {
    if (error && typeof error === 'object' && UUID.test(id)) {
      const known = error instanceof ReviewerBrokerError ? error.diagnostic : undefined;
      errorDiagnostics.set(error, known ?? terminationDiagnostic('unknown_error', null, id));
    }
    throw error;
  }
}

async function submitReviewerBrokerJobInternal(
  job: ReviewerBrokerJob,
  options: { env?: Record<string, string | undefined>; id?: string } = {}
): Promise<ReviewerBrokerResult> {
  const env = options.env ?? process.env;
  const spool = env.OVERSEER_REVIEW_SPOOL?.trim() || DEFAULT_SPOOL;
  const id = options.id ?? randomUUID();
  if (!UUID.test(id))
    throw new ReviewerBrokerError(
      REVIEWER_BROKER_UNAVAILABLE,
      UUID.test(id) ? terminationDiagnostic('broker_unavailable', null, id) : undefined
    );
  const ready = join(spool, 'ready');
  try {
    await access(ready);
  } catch {
    throw new ReviewerBrokerError(
      REVIEWER_BROKER_UNAVAILABLE,
      UUID.test(id) ? terminationDiagnostic('broker_unavailable', null, id) : undefined
    );
  }
  const request = join(spool, `${id}.request.json`);
  const temporary = join(spool, `${id}.request.tmp`);
  const resultPath = join(spool, `${id}.result.json`);
  await writeFile(temporary, JSON.stringify({ version: 1, id, ...job, argv: [...job.argv] }), {
    mode: 0o640,
    flag: 'wx',
  });
  await rename(temporary, request);
  const deadline =
    Date.now() +
    (job.timeoutMs !== undefined
      ? Math.max(timeoutMs(env), job.timeoutMs + MODEL_JOB_GRACE_MS)
      : timeoutMs(env));
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
          throw new ReviewerBrokerError(
            REVIEWER_BROKER_UNAVAILABLE,
            UUID.test(id) ? terminationDiagnostic('invalid_broker_result', null, id) : undefined
          );
        }
        qualifyFableBrokerResult(value, job, id);
        return {
          ...value,
          ...(UUID.test(id) ? { diagnostic: classifyBrokerTermination(value, id) } : {}),
        };
      } catch (error) {
        if (error instanceof ReviewerBrokerError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && !(error instanceof SyntaxError))
          throw new ReviewerBrokerError(
            REVIEWER_BROKER_UNAVAILABLE,
            UUID.test(id) ? terminationDiagnostic('broker_unavailable', null, id) : undefined
          );
      }
      await Bun.sleep(25);
    }
    throw new ReviewerBrokerError(
      REVIEWER_BROKER_UNAVAILABLE,
      UUID.test(id) ? terminationDiagnostic('broker_unavailable', null, id) : undefined
    );
  } finally {
    await Promise.all([
      rm(request, { force: true }),
      rm(temporary, { force: true }),
      rm(resultPath, { force: true }),
    ]);
  }
}

export interface FableExecutionEvidence {
  readonly policy: typeof FABLE_POLICY;
  readonly provider: 'claude';
  readonly model: typeof FABLE_MODEL;
  readonly executableSha256: string;
  readonly version: string;
  readonly accountBindingId: string;
  readonly invocationId: string;
  readonly requestId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly headSha: string;
  readonly permitId: string;
  readonly credentialEgressPassed: true;
}
const trustedFableEvidence = new WeakSet();
export function isTrustedFableEvidence(value: unknown): value is FableExecutionEvidence {
  return !!value && typeof value === 'object' && trustedFableEvidence.has(value);
}
function qualifyFableBrokerResult(
  value: ReviewerBrokerResult,
  job: ReviewerBrokerJob,
  id: string
): void {
  const permit = job.fablePermit;
  if (!permit || !value.ok) return;
  if (value.uid !== 1002 || value.exitCode !== 0 || value.timedOut || value.outputTruncated)
    throw new ReviewerBrokerError();
  if (job.prompt === undefined) {
    if (value.checkPolicy !== FABLE_POLICY) throw new ReviewerBrokerError();
    return;
  }
  const proof = value.fableEvidence;
  if (
    !closedData(proof, [
      'policy',
      'provider',
      'model',
      'executableSha256',
      'version',
      'accountBindingId',
      'invocationId',
      'requestId',
      'workerId',
      'fencingToken',
      'headSha',
      'permitId',
      'credentialEgressPassed',
    ]) ||
    proof.policy !== FABLE_POLICY ||
    proof.provider !== 'claude' ||
    proof.model !== FABLE_MODEL ||
    typeof proof.executableSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(proof.executableSha256) ||
    typeof proof.version !== 'string' ||
    !proof.version ||
    !proof.credentialEgressPassed ||
    proof.invocationId !== id ||
    proof.accountBindingId !== permit.accountBindingId ||
    proof.permitId !== permit.permitId ||
    proof.requestId !== permit.requestId ||
    proof.workerId !== permit.workerId ||
    proof.fencingToken !== permit.fencingToken ||
    proof.headSha !== permit.headSha ||
    Date.parse(permit.expiresAt) <= Date.now()
  )
    throw new ReviewerBrokerError();
  Object.freeze(proof);
  trustedFableEvidence.add(proof);
}
