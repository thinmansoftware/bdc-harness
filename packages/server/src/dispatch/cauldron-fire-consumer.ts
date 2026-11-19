/**
 * WO-HARNESS-T3-COMMAND-CONSUMER-01: the cauldron-fire command consumer.
 *
 * A clock (like outcome-report-clock.ts) that drains the `cauldron-fire`
 * Dispatch mailbox and decides each typed command (fire / cancel-own / approve)
 * exactly once, server-side:
 *   - admission-time dedupe by request_id (retries return the original outcome),
 *   - a WO with a live run is never fired twice,
 *   - cancel-own and approve are restricted to the actor's OWN run,
 *   - approve is bound server-side to the run's own repo/PR/branch and the PR's
 *     CURRENT head sha (the request's stated sha only confirms that head),
 *   - every decision is replied to the submitting actor's mailbox, then the
 *     command row is acknowledged.
 *
 * Fires run through the in-process cascade (deps.fireCascade -> runCascade), the
 * same path Taskmaster uses -- never an HTTP self-call and never the operator
 * token header. Ships disabled: start() is a no-op unless
 * T3_COMMAND_CONSUMER_ENABLED=1.
 *
 * All execution surfaces are injected via CauldronFireConsumerDeps so the tick
 * logic is tested with fakes that count calls, against a real admission ledger.
 */
import { createHash } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from '@archon/core';
import type { IDatabase } from '@archon/core';
import * as dispatchDb from '@archon/core/db/dispatch';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import * as codebasesDb from '@archon/core/db/codebases';
import * as workflowsDb from '@archon/core/db/workflows';
import * as workflowEventsDb from '@archon/core/db/workflow-events';
import { parseDispatchPrincipalsRegistry } from '@archon/core/db/dispatch-sender-authority';
import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
} from '@archon/core/github/service-identity';
import { runCascade, readCascadeRecord } from '@archon/smart-cauldron/cascade';
import * as admissions from '@archon/core/db/t3-command-admissions';
import type { T3CommandAdmissionRow, T3CommandVerb } from '@archon/core/db/t3-command-admissions';
import { checkFireEligibility as checkFireEligibilityImpl } from '../taskmaster/fire-eligibility';
import { matchProjectCodebase } from './project-codebase-match';
import { IN_PROCESS_API_ORIGIN } from '../routes/in-process-authority';
import { findActiveWoClaim } from '@archon/core/db/cascade-wo-claims';
import { cascadeWoClaimDeps, reconcileRetainedWoClaims } from '../cascade/wo-claim';
import {
  approvalHandOffBoundS,
  isApprovalHandOff,
  parseUtcTimestamp,
} from '../cascade/approval-handoff';
// Re-exported: tests and callers import these from the consumer module.
export { approvalHandOffBoundS, isApprovalHandOff, parseUtcTimestamp };
import { hostname } from 'os';
import { randomUUID } from 'crypto';
// Type-only import: the run-action functions are loaded lazily in the real deps
// (dynamic import) so this module -- and its tests -- never statically pull in the
// heavy routes/api graph, which keeps mock-module ordering deterministic in tests.
import type { CancelWorkflowRunActorResult, ApprovePausedWorkflowRunResult } from '../routes/api';

const log = createLogger('dispatch/cauldron-fire-consumer');

export const CAULDRON_FIRE_RECIPIENT = 'cauldron-fire';
export const COMMAND_SCHEMA = 't3-command/v1';
export const REPLY_SCHEMA = 't3-command-reply/v1';
const DEFAULT_POLL_MS = 15000;
const COMMAND_LIST_LIMIT = 50;

export interface T3Command {
  schema: string;
  request_id: string;
  verb: T3CommandVerb;
  wo_id?: string;
  project: string;
  lane?: string;
  run_id?: string;
  pr?: string;
  head_sha?: string;
  run_id_for_approve?: string;
  /** approve: the approval node id the actor reviewed (Amendment 5 A5.8). */
  node_id?: string;
  thread_id?: string;
}

export interface ReplyOutcome {
  status: number;
  code: string;
  run_id?: string | null;
  cascade_id?: string | null;
  /** 503 failed_before_effect only: the thrown error's class name (never its message). */
  error_class?: string;
}

/** Reply text carried with every 409 admission_unknown (Amendment 2 A2.2 rule 2). */
export const ADMISSION_UNKNOWN_TEXT = 'unknown, adjudication required';
/** Seconds after which a reservation no handler holds is swept (A2.2 rule 4). */
const DEFAULT_RESERVATION_STALE_S = 300;
/** A5.1: one canonical WO identifier, nothing around it. */
export const WO_ID_PATTERN = /^WO-[A-Z][A-Z0-9-]*-\d+$/;
const MAX_WO_ID_LENGTH = 96;
/** A5.12: echoed reply fields are bounded so a reply can always be written. */
const MAX_ECHOED_FIELD_LENGTH = 128;
/** A5.6: a new command older than this is refused 409 expired. */
const DEFAULT_MAX_AGE_S = 900;
/** A5.12: failed processing attempts before a row is dead-lettered. */
const DEAD_LETTER_ATTEMPTS = 3;
/** A5.3: every non-terminal WorkflowRunStatus. */
export const NON_TERMINAL_RUN_STATUSES = [
  'pending',
  'running',
  'waiting_provider',
  'interrupted',
  'orphaned',
  'paused',
] as const;

/** A5.7: a CAS transition found the reservation owned or resolved elsewhere. */
class CasLostError extends Error {}
/** A5.5: the actor's mailbox cannot be resolved; never ack without a reply. */
class MailboxUnresolvedError extends Error {}

export interface PullRequestIdentity {
  open: boolean;
  headRepo: string;
  baseRepo: string;
  headRef: string;
  baseRef: string;
  headSha: string;
}

export interface CauldronFireConsumerDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  /** Admission ledger backing store (real DB in production; test adapter in tests). */
  db: IDatabase;

  // --- Dispatch transport ---
  /** Queued rows for the recipient, oldest-first. */
  listCommands: (recipient: string, limit: number) => Promise<DispatchMessage[]>;
  /** Send one reply as the cauldron-fire system sender; idempotent on idempotencyKey. */
  sendReply: (input: {
    recipient: string;
    correlationId: string;
    idempotencyKey: string;
    body: string;
  }) => Promise<DispatchMessage>;
  /** Acknowledge a command row as cauldron-fire. */
  acknowledge: (messageId: string) => Promise<void>;
  /** First receive_as mailbox of the submitting actor's credential (null when unknown). */
  resolveActorMailbox: (principalOrSender: string) => string | null;

  // --- Project / codebase ---
  /**
   * Normalized repository (owner/name) for a registered codebase named `project`.
   * `null` when the project is registered but has no repository_url; `undefined`
   * when the project is not a registered codebase at all.
   */
  resolveProjectRepository: (project: string) => Promise<string | null | undefined>;

  // --- Fire ---
  /** True + the live run id when a pending/running/paused run already names this WO. */
  hasLiveWorkflowRun: (woId: string) => Promise<{ live: boolean; runId: string | null }>;
  /** Eligibility (A5.2): evidence carries the canonical woId, the spec's project and the pinned spec. */
  checkFireEligibility: (issueTitle: string) => Promise<{
    eligible: boolean;
    reason?: string;
    evidence?: { woId: string; project: string; expectedSpec?: unknown };
  }>;
  fireCascade: (input: {
    woId: string;
    project: string;
    lane?: string;
    dispatchId: string;
    /** Called once PER run the cascade discovers, on every tier (Amendment 3). */
    onRunDiscovered?: (runId: string, tier: string | null) => void;
    /** The pinned spec identity from eligibility evidence (A5.2). */
    expectedSpec?: unknown;
  }) => Promise<{ cascadeId: string; status: string; runId: string | null }>;
  /** Known lane overrides; an unknown lane is refused 400 unknown_lane. Empty/omitted = no lane check. */
  knownLanes?: readonly string[];

  // --- Cancel / approve (shared api.ts functions) ---
  cancelRun: (
    runId: string,
    opts: { reason: string; actor: string }
  ) => Promise<CancelWorkflowRunActorResult>;
  approveRun: (
    runId: string,
    opts: {
      comment: string;
      decisionVerb: 'approve_as_is';
      authorizedFixIds: string[];
      /** The reviewed gate; enforced inside the approval's conditional update. */
      expectedNodeId: string;
    }
  ) => Promise<ApprovePausedWorkflowRunResult>;

  // --- Recovery proofs (Amendment 2 A2.2 rule 4; read-only, never re-execute) ---
  /** Fire custody: the cascade's run exists and names the WO (as loop.ts verifies). */
  proveFireCustody: (
    row: T3CommandAdmissionRow
  ) => Promise<{ runId: string; cascadeId: string | null; runIds: string[] } | null>;
  /** Run ids recorded in a cascade's attempts (custody fallback; Amendment 3). */
  readCascadeRunIds: (cascadeId: string) => Promise<string[]>;
  /** The run is cancelled and its run_cancelled event names this actor. */
  proveCancel: (runId: string, actor: string) => Promise<boolean>;
  /** An approval_received event for the run at or after `sinceIso`. */
  proveApprove: (runId: string, sinceIso: string) => Promise<boolean>;

  // --- Amendment 5 ---
  /** The paused run's approval gate (metadata.approval), or null when not paused at one. */
  getRunApproval: (
    runId: string
  ) => Promise<{ nodeId: string; type: string | null; captureResponse: boolean } | null>;
  /** Non-terminal runs naming the WO that started at or after `sinceIso` (A5.9). */
  findRunsForWoSince: (woId: string, sinceIso: string) => Promise<string[]>;
  /** Durable operator alert (A5.12 dead-letter). */
  alertOperator: (input: {
    subject: string;
    body: string;
    idempotencyKey: string;
  }) => Promise<void>;
  /** This process's consumer lease identity (A5.7). */
  leaseHolder: string;

  // --- Approve bindings (all derived server-side) ---
  /** Normalized repository of the run's codebase (run.codebase_id -> repository_url). */
  getRunRepository: (runId: string) => Promise<string | null>;
  /** The run's working branch (run authority head_branch). */
  getRunBranch: (runId: string) => Promise<string | null>;
  /** The PR identity read from GitHub with the service identity. */
  getPullRequest: (repo: string, number: number) => Promise<PullRequestIdentity | null>;
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function normalizeRepo(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

/** Parse "owner/repo#N" -> { repo, number }; null when malformed. */
export function parsePrRef(pr: string): { repo: string; number: number } | null {
  const match = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(pr.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: normalizeRepo(match[1]), number };
}

/** Stable JSON over sorted top-level keys so a byte-equal command hashes equally. */
export function canonicalDigest(cmd: T3Command): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(cmd).sort()) {
    sorted[key] = (cmd as unknown as Record<string, unknown>)[key];
  }
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Token (word-boundary) match of a WO id inside free text -- not a substring match. */
export function userMessageNamesWo(userMessage: string, woId: string): boolean {
  if (!woId) return false;
  const escaped = woId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`).test(userMessage);
}

const VALID_VERBS: readonly T3CommandVerb[] = ['fire', 'cancel-own', 'approve'];
const HEX40 = /^[0-9a-f]{40}$/;

export type Validated = { ok: true; cmd: T3Command } | { ok: false; outcome: ReplyOutcome };

/** Step 1 validation. Pure except for the allowlist/registration lookups. */
export async function validateCommand(
  deps: CauldronFireConsumerDeps,
  message: DispatchMessage
): Promise<Validated> {
  const actors = parseList(deps.env.T3_COMMAND_ACTORS);
  const sender = message.sender;
  const principal = message.sender_principal_id;
  if (!principal || principal !== sender || !actors.includes(principal)) {
    return { ok: false, outcome: { status: 403, code: 'actor_not_allowed' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.body);
  } catch {
    return { ok: false, outcome: { status: 400, code: 'invalid_body' } };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, outcome: { status: 400, code: 'invalid_body' } };
  }
  const body = parsed as Record<string, unknown>;
  if (body.schema !== COMMAND_SCHEMA) {
    return { ok: false, outcome: { status: 400, code: 'invalid_schema' } };
  }
  if (typeof body.request_id !== 'string' || body.request_id !== message.idempotency_key) {
    return { ok: false, outcome: { status: 400, code: 'request_id_mismatch' } };
  }
  // A5.12: echoed fields are bounded so the reply can always be written.
  if (
    body.request_id.length > MAX_ECHOED_FIELD_LENGTH ||
    (body.thread_id !== undefined &&
      (typeof body.thread_id !== 'string' || body.thread_id.length > MAX_ECHOED_FIELD_LENGTH))
  ) {
    return { ok: false, outcome: { status: 400, code: 'invalid_field' } };
  }
  if (typeof body.verb !== 'string' || !VALID_VERBS.includes(body.verb as T3CommandVerb)) {
    return { ok: false, outcome: { status: 400, code: 'unknown_verb' } };
  }
  if (typeof body.project !== 'string' || body.project.length === 0) {
    return { ok: false, outcome: { status: 400, code: 'project_missing' } };
  }
  const verb = body.verb as T3CommandVerb;
  const cmd: T3Command = {
    schema: COMMAND_SCHEMA,
    request_id: body.request_id,
    verb,
    project: body.project,
    wo_id: typeof body.wo_id === 'string' ? body.wo_id : undefined,
    lane: typeof body.lane === 'string' ? body.lane : undefined,
    run_id: typeof body.run_id === 'string' ? body.run_id : undefined,
    pr: typeof body.pr === 'string' ? body.pr : undefined,
    head_sha: typeof body.head_sha === 'string' ? body.head_sha : undefined,
    run_id_for_approve:
      typeof body.run_id_for_approve === 'string' ? body.run_id_for_approve : undefined,
    node_id: typeof body.node_id === 'string' ? body.node_id : undefined,
    thread_id: typeof body.thread_id === 'string' ? body.thread_id : undefined,
  };

  // Per-verb required fields.
  if (verb === 'fire' && !cmd.wo_id) {
    return { ok: false, outcome: { status: 400, code: 'wo_id_missing' } };
  }
  // A5.1: exactly one canonical WO identifier -- never free text that run
  // arguments, locks or live-run scans could split on.
  if (
    verb === 'fire' &&
    cmd.wo_id &&
    (cmd.wo_id.length > MAX_WO_ID_LENGTH || !WO_ID_PATTERN.test(cmd.wo_id))
  ) {
    return { ok: false, outcome: { status: 400, code: 'invalid_wo_id' } };
  }
  if (verb === 'cancel-own' && !cmd.run_id) {
    return { ok: false, outcome: { status: 400, code: 'run_id_missing' } };
  }
  if (verb === 'approve') {
    if (!cmd.run_id_for_approve || !cmd.pr || !cmd.head_sha || !cmd.node_id) {
      return { ok: false, outcome: { status: 400, code: 'approve_fields_missing' } };
    }
    if (!HEX40.test(cmd.head_sha) || !parsePrRef(cmd.pr)) {
      return { ok: false, outcome: { status: 400, code: 'approve_fields_invalid' } };
    }
  }

  // Project allowlist + registration (every verb).
  const projects = parseList(deps.env.T3_COMMAND_PROJECTS);
  if (!projects.includes(cmd.project)) {
    return { ok: false, outcome: { status: 403, code: 'project_not_allowed' } };
  }
  const repo = await deps.resolveProjectRepository(cmd.project);
  if (repo === undefined) {
    return { ok: false, outcome: { status: 400, code: 'project_not_registered' } };
  }

  return { ok: true, cmd };
}

function replayOutcome(row: T3CommandAdmissionRow): ReplyOutcome {
  return {
    status: row.status_code ?? 409,
    code: row.code ?? 'admission_unknown',
    run_id: row.run_id,
    cascade_id: row.cascade_id,
  };
}

/**
 * Reconcile a fire whose effect cannot be proven into the ONE in-contract
 * unknown outcome (cascade threw / returned no run id / admitted-outcome write
 * failed).
 *
 * Reply contract (docs/runbooks/t3-command-consumer.md): reply status is one of
 * 200 | 400 | 403 | 409 | 422, and an unproven admission is 409
 * `admission_unknown` -- byte-identical to what startup recovery replies, so a
 * later retry replays the same in-contract outcome. 5xx is NOT in the contract.
 * The specific cause stays in the logs (each call site logs a distinct event),
 * never on the wire.
 *
 * Whatever identity was actually observed is persisted, so a retry returns the
 * executed run/cascade instead of null. The row is NEVER marked refused: that
 * would release the WO and permit a duplicate fire once the run completes.
 */
async function reconcileFireUnknown(
  deps: CauldronFireConsumerDeps,
  requestId: string,
  observed: { cascadeId?: string | null; runId?: string | null },
  now: string
): Promise<ReplyOutcome> {
  await admissions
    .markUnknown(
      requestId,
      {
        status_code: 409,
        code: 'admission_unknown',
        cascade_id: observed.cascadeId ?? null,
        run_id: observed.runId ?? null,
        now,
      },
      deps.db
    )
    // Best effort: if even this write fails the row stays `reserved`, and
    // startup recovery reconciles it to unknown. Still never refired.
    .catch(() => undefined);
  return {
    status: 409,
    code: 'admission_unknown',
    run_id: observed.runId ?? null,
    cascade_id: observed.cascadeId ?? null,
  };
}

function cancelCode(status: number): string {
  if (status === 409) return 'already_cancelled';
  if (status === 422) return 'run_terminal';
  if (status === 404) return 'run_not_found';
  return 'cancel_refused';
}

// --------------------------------------------------------------------------
// Verb handlers (each reserves, executes, and marks the admission)
// --------------------------------------------------------------------------

async function handleFire(
  deps: CauldronFireConsumerDeps,
  cmd: T3Command,
  message: DispatchMessage,
  actor: string,
  now: string,
  digest: string
): Promise<ReplyOutcome> {
  const woId = cmd.wo_id;
  if (!woId) throw new Error('t3_fire_wo_id_missing'); // unreachable post-validation
  const fireFields = {
    request_id: cmd.request_id,
    actor_principal_id: actor,
    verb: 'fire' as const,
    payload_sha256: digest,
    wo_id: woId,
    project: cmd.project,
    thread_id: cmd.thread_id ?? null,
    source_message_id: message.id,
  };

  // Live-run refusal (server-side): an existing pending/running/paused run.
  const live = await deps.hasLiveWorkflowRun(woId);
  if (live.live) {
    await admissions.insertRefused(
      { ...fireFields, status_code: 409, code: 'live_run', run_id: live.runId ?? null, now },
      deps.db
    );
    return { status: 409, code: 'live_run', run_id: live.runId ?? cmd.request_id };
  }
  // Live-run refusal: another fire admission for this WO is unresolved --
  // mid-admission (reserved) or unproven (unknown, awaiting operator
  // adjudication; its run may exist but be invisible to the scan above). A
  // completed `admitted` row does not block -- that run's liveness is owned by
  // hasLiveWorkflowRun above, not by the admission ledger.
  const competitor = await admissions.findLiveFireForWo(woId, cmd.request_id, deps.db);
  if (competitor?.state === 'unknown') {
    // Reply with the ORIGINAL admission id: it is the key the operator
    // adjudicates (adjudicateUnknownFire), and an unproven run id is not one.
    await admissions.insertRefused(
      {
        ...fireFields,
        status_code: 409,
        code: 'admission_unknown',
        run_id: competitor.request_id,
        now,
      },
      deps.db
    );
    return {
      status: 409,
      code: 'admission_unknown',
      run_id: competitor.request_id,
      cascade_id: competitor.cascade_id ?? null,
    };
  }
  if (competitor) {
    await admissions.insertRefused(
      {
        ...fireFields,
        status_code: 409,
        code: 'live_run',
        run_id: competitor.run_id ?? null,
        now,
      },
      deps.db
    );
    return { status: 409, code: 'live_run', run_id: competitor.run_id ?? competitor.request_id };
  }
  // A5.3(c): the shared WO claim (Taskmaster or T3 cascade, any tier, during
  // discovery). Enforced again atomically by the claim inside runCascade.
  const claim = await findActiveWoClaim(woId, deps.db);
  if (claim) {
    await admissions.insertRefused(
      { ...fireFields, status_code: 409, code: 'live_run', cascade_id: claim.cascade_id, now },
      deps.db
    );
    return { status: 409, code: 'live_run', cascade_id: claim.cascade_id };
  }

  const reserved = await admissions.reserveAdmission({ ...fireFields, now }, deps.db);
  if (reserved.status === 'wo_fire_locked') {
    // Lost the admission race to a concurrent reservation.
    await admissions.insertRefused(
      { ...fireFields, status_code: 409, code: 'live_run', now },
      deps.db
    );
    return { status: 409, code: 'live_run', run_id: cmd.request_id };
  }
  if (reserved.status === 'exists') {
    return replayOutcome(reserved.row);
  }

  // Unknown lane: refuse before firing.
  if (
    cmd.lane &&
    deps.knownLanes &&
    deps.knownLanes.length > 0 &&
    !deps.knownLanes.includes(cmd.lane)
  ) {
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 400, code: 'unknown_lane', now },
      deps.db
    );
    return { status: 400, code: 'unknown_lane' };
  }

  const eligibility = await deps.checkFireEligibility(woId);
  const evidence = eligibility.evidence;
  if (!eligibility.eligible || !evidence) {
    const reason = eligibility.eligible ? 'evidence_missing' : (eligibility.reason ?? 'unknown');
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 409, code: `fire_ineligible:${reason}`, now },
      deps.db
    );
    return { status: 409, code: `fire_ineligible:${reason}` };
  }
  // A5.1 / A5.2: the eligibility evidence is binding -- same WO id, the spec's
  // own project, and the pinned spec revision travels to the cascade.
  if (evidence.woId !== woId) {
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 409, code: 'wo_id_mismatch', now },
      deps.db
    );
    return { status: 409, code: 'wo_id_mismatch' };
  }
  if (evidence.project !== cmd.project) {
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 409, code: 'wo_project_mismatch', now },
      deps.db
    );
    return { status: 409, code: 'wo_project_mismatch' };
  }

  let result: { cascadeId: string; status: string; runId: string | null };
  // Durable effect marker, committed BEFORE the side effect (A2.2); CAS (A5.7).
  if (!(await admissions.markEffectStarted(cmd.request_id, deps.now().toISOString(), deps.db))) {
    throw new CasLostError('t3_fire_reservation_not_owned');
  }
  try {
    result = await deps.fireCascade({
      woId,
      project: cmd.project,
      lane: cmd.lane,
      dispatchId: cmd.request_id,
      expectedSpec: evidence.expectedSpec,
      // Amendment 3: durable custody for EVERY run, on every tier.
      onRunDiscovered: (runId, tier) => {
        void admissions
          .appendRunCustody(
            { admission_id: cmd.request_id, run_id: runId, tier, now: deps.now().toISOString() },
            deps.db
          )
          .catch((error: unknown) => {
            log.warn(
              { runId, cause: (error as Error).message?.slice(0, 200) },
              'cauldron_fire_custody_append_failed'
            );
          });
      },
    });
  } catch (error) {
    // The cascade invocation threw before returning a result. We cannot prove
    // whether a run was created, so releasing the WO (markRefused) risks a
    // double-fire once any created run completes. Reconcile as `unknown`: the
    // actor is told 409 admission_unknown and the fire is NEVER refired
    // automatically (startup recovery / operator adjudicates instead). No run or
    // cascade id was observed, so none is recorded.
    log.warn(
      { woId, cause: (error as Error).message.slice(0, 200) },
      'cauldron_fire_cascade_failed'
    );
    return reconcileFireUnknown(deps, cmd.request_id, {}, now);
  }

  // Command contract: a fire is only `ok` when it yields a verifiable run id
  // (custody of a specific run). A cascade that returns no run id cannot be
  // confirmed, so it is NOT replied as success -- record it as `unknown` so it
  // is never reported ok and never refired automatically.
  if (!result.runId && result.status === 'blocked') {
    // A5.0: the shared WO claim refused the cascade before any dispatch (zero
    // attempts) -- proven non-execution. Another cascade holds this WO.
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 409, code: 'live_run', cascade_id: result.cascadeId, now },
      deps.db
    );
    return { status: 409, code: 'live_run', cascade_id: result.cascadeId };
  }
  if (!result.runId) {
    log.warn({ woId, cascadeId: result.cascadeId }, 'cauldron_fire_no_run_id');
    return reconcileFireUnknown(deps, cmd.request_id, { cascadeId: result.cascadeId }, now);
  }

  try {
    await admissions.markAdmitted(
      cmd.request_id,
      {
        status_code: 200,
        code: 'ok',
        cascade_id: result.cascadeId,
        run_id: result.runId,
        now,
      },
      deps.db
    );
  } catch (error) {
    // The cascade executed and produced run `result.runId`, but persisting the
    // admitted outcome failed. Do NOT mark refused -- that would release the WO
    // and allow a duplicate fire after the run completes. Reconcile as `unknown`
    // AND persist the executed cascade/run ids, so a retry replays this run's
    // identity instead of null.
    log.warn(
      { woId, runId: result.runId, cause: (error as Error).message.slice(0, 200) },
      'cauldron_fire_admit_persist_failed'
    );
    return reconcileFireUnknown(
      deps,
      cmd.request_id,
      { cascadeId: result.cascadeId, runId: result.runId },
      now
    );
  }
  return { status: 200, code: 'ok', run_id: result.runId, cascade_id: result.cascadeId };
}

/**
 * Ownership (Amendment 3 A3.1): custody rows (every run the actor's fire
 * cascades created, on every tier) or the admission's own run id. Only when NO
 * custody row exists for the run does it fall back to the actor's cascade
 * records -- logged, and the missing custody row is appended.
 */
async function actorOwnsRun(
  deps: CauldronFireConsumerDeps,
  actor: string,
  runId: string
): Promise<boolean> {
  if (await admissions.ownsRun(actor, runId, deps.db)) return true;
  if (await admissions.hasRunCustody(runId, deps.db)) return false;
  const fires = await admissions.listAdmittedFiresForActor(actor, deps.db);
  for (const fire of fires) {
    const runIds = await deps.readCascadeRunIds(fire.cascade_id ?? fire.request_id);
    if (runIds.includes(runId)) {
      log.warn({ runId, admissionId: fire.request_id }, 'cauldron_fire_custody_fallback_used');
      await admissions.appendRunCustody(
        { admission_id: fire.request_id, run_id: runId, tier: null, now: deps.now().toISOString() },
        deps.db
      );
      return true;
    }
  }
  return false;
}

async function handleCancel(
  deps: CauldronFireConsumerDeps,
  cmd: T3Command,
  message: DispatchMessage,
  actor: string,
  now: string,
  digest: string
): Promise<ReplyOutcome> {
  const runId = cmd.run_id;
  if (!runId) throw new Error('t3_cancel_run_id_missing'); // unreachable post-validation
  const fields = {
    request_id: cmd.request_id,
    actor_principal_id: actor,
    verb: 'cancel-own' as const,
    payload_sha256: digest,
    wo_id: cmd.wo_id ?? null,
    project: cmd.project,
    target_run_id: runId,
    thread_id: cmd.thread_id ?? null,
    source_message_id: message.id,
  };
  const locked = await refuseIfRunLocked(deps, fields, runId, now);
  if (locked) return locked;
  const reserved = await admissions.reserveAdmission({ ...fields, now }, deps.db);
  if (reserved.status === 'exists') return replayOutcome(reserved.row);
  if (reserved.status !== 'reserved') {
    return refuseRunLocked(deps, fields, runId, now);
  }

  if (!(await actorOwnsRun(deps, actor, runId))) {
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 403, code: 'forbidden_not_own_run', now },
      deps.db
    );
    return { status: 403, code: 'forbidden_not_own_run' };
  }

  // Amendment 4 A4.1: the run's project is the one its owning fire admission
  // recorded, never the request's. A different requested project is refused,
  // and the recorded project must still be allowlisted at cancel time.
  const projectRefusal = await owningProjectRefusal(deps, actor, runId, cmd.project);
  if (projectRefusal) {
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 403, code: projectRefusal, now },
      deps.db
    );
    return { status: 403, code: projectRefusal };
  }

  // Durable effect marker, committed BEFORE the side effect (A2.2); CAS (A5.7).
  if (!(await admissions.markEffectStarted(cmd.request_id, deps.now().toISOString(), deps.db))) {
    throw new CasLostError('t3_cancel_reservation_not_owned');
  }
  const result = await deps.cancelRun(runId, { reason: 'T3 cancel-own', actor });
  if (!result.ok) {
    const code = cancelCode(result.status);
    await admissions.markRefused(
      cmd.request_id,
      { status_code: result.status, code, now },
      deps.db
    );
    return { status: result.status, code };
  }
  await admissions.markAdmitted(
    cmd.request_id,
    { status_code: 200, code: 'ok', run_id: runId, now },
    deps.db
  );
  return { status: 200, code: 'ok', run_id: runId };
}

/**
 * A4.1 / A5.8: the run's project is the one its owning fire admission recorded.
 * Returns the refusal code, or null when the requested project is that project
 * and it is still allowlisted.
 */
async function owningProjectRefusal(
  deps: CauldronFireConsumerDeps,
  actor: string,
  runId: string,
  requestedProject: string
): Promise<string | null> {
  const owning = await admissions.findOwningFireAdmission(actor, runId, deps.db);
  const runProject = owning?.project ?? null;
  if (!runProject || runProject !== requestedProject) return 'project_mismatch';
  if (!parseList(deps.env.T3_COMMAND_PROJECTS).includes(runProject)) return 'project_not_allowed';
  return null;
}

/**
 * Run lock (A2.2 rule 2): another cancel-own / approve for this run is
 * unresolved. An `unknown` holder is refused 409 admission_unknown naming the
 * holding request_id (in run_id) until an operator adjudicates; a `reserved`
 * holder is mid-execution and refused 409 command_in_flight. The refusal is
 * recorded so a retry of this request replays it.
 */
async function refuseIfRunLocked(
  deps: CauldronFireConsumerDeps,
  fields: Omit<admissions.ReserveAdmissionInput, 'now'>,
  runId: string,
  now: string
): Promise<ReplyOutcome | null> {
  const holder = await admissions.findRunLockHolder(runId, fields.request_id, deps.db);
  return holder ? refuseRunLocked(deps, fields, runId, now) : null;
}

/** Record and return the run-lock refusal (also used when a reservation lost the race). */
async function refuseRunLocked(
  deps: CauldronFireConsumerDeps,
  fields: Omit<admissions.ReserveAdmissionInput, 'now'>,
  runId: string,
  now: string
): Promise<ReplyOutcome> {
  const holder = await admissions.findRunLockHolder(runId, fields.request_id, deps.db);
  const code = holder?.state === 'unknown' ? 'admission_unknown' : 'command_in_flight';
  const holdingId = holder?.request_id ?? null;
  await admissions.insertRefused(
    { ...fields, status_code: 409, code, run_id: holdingId, now },
    deps.db
  );
  return { status: 409, code, run_id: holdingId };
}

async function handleApprove(
  deps: CauldronFireConsumerDeps,
  cmd: T3Command,
  message: DispatchMessage,
  actor: string,
  now: string,
  digest: string
): Promise<ReplyOutcome> {
  const runId = cmd.run_id_for_approve;
  const prText = cmd.pr;
  if (!runId || !prText) throw new Error('t3_approve_fields_missing'); // unreachable post-validation
  const prRef = parsePrRef(prText);
  const fields = {
    request_id: cmd.request_id,
    actor_principal_id: actor,
    verb: 'approve' as const,
    payload_sha256: digest,
    wo_id: cmd.wo_id ?? null,
    project: cmd.project,
    target_run_id: runId,
    pr_ref: cmd.pr ?? null,
    head_sha: cmd.head_sha ?? null,
    thread_id: cmd.thread_id ?? null,
    source_message_id: message.id,
  };
  const locked = await refuseIfRunLocked(deps, fields, runId, now);
  if (locked) return locked;
  const reserved = await admissions.reserveAdmission({ ...fields, now }, deps.db);
  if (reserved.status === 'exists') return replayOutcome(reserved.row);
  if (reserved.status !== 'reserved') {
    return refuseRunLocked(deps, fields, runId, now);
  }

  const refuse = async (status: number, code: string): Promise<ReplyOutcome> => {
    await admissions.markRefused(cmd.request_id, { status_code: status, code, now }, deps.db);
    return { status, code };
  };

  // (i) OWNERSHIP: the actor must have fired this run through this consumer.
  if (!(await actorOwnsRun(deps, actor, runId))) {
    return refuse(403, 'forbidden_not_own_run');
  }
  // (i-b) A5.8: the owning fire admission's recorded project, as A4.1 for cancel.
  const projectRefusal = await owningProjectRefusal(deps, actor, runId, cmd.project);
  if (projectRefusal) return refuse(403, projectRefusal);
  // (i-c) A5.8: bound to the exact gate the actor reviewed; free-text gates are
  // not approvable by command.
  const gate = await deps.getRunApproval(runId);
  if (!gate || gate.nodeId !== cmd.node_id) return refuse(409, 'gate_mismatch');
  if (gate.type === 'interactive_loop' || gate.captureResponse) {
    return refuse(409, 'gate_not_supported');
  }
  // (ii) PROJECT/REPO: run repo == admission project repo == PR repo.
  if (!prRef) return refuse(409, 'run_pr_mismatch');
  const projectRepo = await deps.resolveProjectRepository(cmd.project);
  const runRepo = await deps.getRunRepository(runId);
  if (
    !projectRepo ||
    !runRepo ||
    normalizeRepo(runRepo) !== normalizeRepo(projectRepo) ||
    prRef.repo !== normalizeRepo(projectRepo)
  ) {
    return refuse(409, 'run_pr_mismatch');
  }
  // (iii) PR IDENTITY: open, same-repo (no fork), head ref == run's working branch.
  const pr = await deps.getPullRequest(prRef.repo, prRef.number);
  const runBranch = await deps.getRunBranch(runId);
  if (
    !pr ||
    !pr.open ||
    normalizeRepo(pr.headRepo) !== normalizeRepo(pr.baseRepo) ||
    !runBranch ||
    pr.headRef !== runBranch
  ) {
    return refuse(409, 'run_pr_mismatch');
  }
  // (iv) BASE: the PR base owner/repo:branch must be allowlisted (never production).
  const allowedBases = parseList(deps.env.T3_COMMAND_APPROVE_BASES);
  const base = `${normalizeRepo(pr.baseRepo)}:${pr.baseRef}`;
  if (!allowedBases.includes(base)) {
    return refuse(403, 'base_not_allowed');
  }
  // (v) REVIEWED COMMIT: the PR's CURRENT head sha must equal the stated sha.
  if (pr.headSha !== cmd.head_sha) {
    return refuse(422, 'stale_head');
  }

  // Durable effect marker, committed BEFORE the side effect (A2.2): the approve
  // function's first event write is the effect. CAS (A5.7).
  const approvedSince = deps.now().toISOString();
  if (!(await admissions.markEffectStarted(cmd.request_id, approvedSince, deps.db))) {
    throw new CasLostError('t3_approve_reservation_not_owned');
  }
  const result = await deps.approveRun(runId, {
    comment: 'T3 approve',
    decisionVerb: 'approve_as_is',
    authorizedFixIds: [],
    expectedNodeId: cmd.node_id ?? '',
  });
  if (!result.ok) {
    // The gate moved between the check and the approval's conditional update:
    // nothing was written (no approval events).
    if (result.status === 409 && result.message === 'gate_changed') {
      return refuse(409, 'gate_changed');
    }
    return refuse(result.status, 'approve_refused');
  }
  // A2.1 item 4/6: `approved` only when the resume was dispatched; otherwise the
  // approval is recorded but the run needs an operator follow-up. An approval
  // that already existed was not resumed by this command either.
  const code =
    result.kind === 'approved' && result.autoResumed ? 'approved' : 'approved_not_resumed';
  await admissions.markAdmitted(
    cmd.request_id,
    { status_code: 200, code, run_id: runId, now },
    deps.db
  );
  // A5.9: a resume that started a FRESH run for the WO stays in the actor's custody.
  const owning = await admissions.findOwningFireAdmission(actor, runId, deps.db);
  if (owning?.wo_id) {
    for (const freshRunId of await deps.findRunsForWoSince(owning.wo_id, approvedSince)) {
      if (freshRunId === runId) continue;
      await admissions.appendRunCustody(
        { admission_id: owning.request_id, run_id: freshRunId, tier: 'resume', now },
        deps.db
      );
    }
  }
  return { status: 200, code, run_id: runId };
}

// --------------------------------------------------------------------------
// Per-command processing + tick
// --------------------------------------------------------------------------

/**
 * The reply for an admission-owning command is the ledger's decision. Returns
 * `outcome` when the durable row agrees (keeping reply-only fields such as
 * error_class); the durable row's outcome when it was decided differently; and
 * 409 stale_reservation when there is no decided row at all.
 */
async function durableOutcome(
  deps: CauldronFireConsumerDeps,
  requestId: string,
  outcome: ReplyOutcome
): Promise<ReplyOutcome> {
  const row = await admissions.getByRequestId(requestId, deps.db);
  if (!row || row.state === 'reserved' || row.status_code === null) {
    log.warn({ requestId, state: row?.state ?? null }, 'cauldron_fire_stale_reservation');
    return { status: 409, code: 'stale_reservation' };
  }
  if (row.status_code === outcome.status && row.code === outcome.code) return outcome;
  log.warn(
    { requestId, durable: row.code, attempted: outcome.code },
    'cauldron_fire_terminal_cas_lost'
  );
  return replayOutcome(row);
}

async function sendReplyAndAck(
  deps: CauldronFireConsumerDeps,
  message: DispatchMessage,
  cmd: T3Command | null,
  outcome: ReplyOutcome,
  now: string,
  recordOnAdmission: boolean
): Promise<void> {
  const requestId = cmd?.request_id ?? message.correlation_id ?? message.idempotency_key;
  if (recordOnAdmission) {
    // Honor every terminal-transition CAS: the reply is the DURABLE decision.
    // When a handler's markAdmitted / markRefused / markUnknown lost its CAS
    // (another process or recovery decided the row first), never reply the
    // handler's outcome -- reply what the ledger holds, or 409 stale_reservation.
    outcome = await durableOutcome(deps, requestId, outcome);
  }
  const mailbox = deps.resolveActorMailbox(message.sender_principal_id ?? message.sender);
  if (mailbox) {
    const replyBody = JSON.stringify({
      schema: REPLY_SCHEMA,
      request_id: requestId,
      verb: cmd?.verb ?? null,
      status: outcome.status,
      code: outcome.code,
      run_id: outcome.run_id ?? null,
      cascade_id: outcome.cascade_id ?? null,
      thread_id: cmd?.thread_id ?? null,
      ...(outcome.error_class ? { error_class: outcome.error_class } : {}),
      ...(outcome.code === 'admission_unknown' ? { message: ADMISSION_UNKNOWN_TEXT } : {}),
    });
    const reply = await deps.sendReply({
      recipient: mailbox,
      correlationId: requestId,
      idempotencyKey: `reply:${message.id}`,
      body: replyBody,
    });
    if (recordOnAdmission) {
      await admissions.recordReply(requestId, reply.id, now, deps.db);
    }
  } else {
    // A5.5: never acknowledge without a durable reply row. The row stays queued;
    // the attempt counts toward the dead-letter threshold (A5.12).
    log.error(
      { sender: message.sender, principal: message.sender_principal_id },
      'cauldron_fire_reply_mailbox_unresolved'
    );
    throw new MailboxUnresolvedError('t3_reply_mailbox_unresolved');
  }
  await deps.acknowledge(message.id);
}

/** Request ids whose verb handler is executing in this process right now. */
const inFlightRequests = new Set<string>();

function errorClassOf(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name || 'Error';
  return typeof error;
}

/**
 * An exception escaped a verb handler (A2.2 rules 1 and 2). Decide a durable
 * outcome from the admission row and the effect marker, reply, and acknowledge
 * -- a command is never left silent or queued forever.
 */
async function resolveHandlerException(
  deps: CauldronFireConsumerDeps,
  message: DispatchMessage,
  cmd: T3Command,
  actor: string,
  digest: string,
  error: unknown
): Promise<void> {
  const now = deps.now().toISOString();
  const errorClass = errorClassOf(error);
  const row = await admissions.getByRequestId(cmd.request_id, deps.db);
  if (!row) {
    // Threw before any reservation (a pre-admission read): nothing executed.
    await admissions.insertRefused(
      {
        request_id: cmd.request_id,
        actor_principal_id: actor,
        verb: cmd.verb,
        payload_sha256: digest,
        wo_id: cmd.wo_id ?? null,
        project: cmd.project,
        target_run_id:
          cmd.verb === 'cancel-own' ? (cmd.run_id ?? null) : (cmd.run_id_for_approve ?? null),
        thread_id: cmd.thread_id ?? null,
        source_message_id: message.id,
        status_code: 503,
        code: 'failed_before_effect',
        now,
      },
      deps.db
    );
    await sendReplyAndAck(
      deps,
      message,
      cmd,
      { status: 503, code: 'failed_before_effect', error_class: errorClass },
      now,
      true
    );
    return;
  }
  if (row.source_message_id !== message.id || row.state !== 'reserved') {
    // Already decided (e.g. the reply or ack step threw): replay, never re-decide.
    await sendReplyAndAck(
      deps,
      message,
      cmd,
      replayOutcome(row),
      now,
      row.source_message_id === message.id
    );
    return;
  }
  if (!row.effect_started_at) {
    // Rule 1: failed before any side effect -> refused, lock released.
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 503, code: 'failed_before_effect', now },
      deps.db
    );
    await sendReplyAndAck(
      deps,
      message,
      cmd,
      { status: 503, code: 'failed_before_effect', error_class: errorClass },
      now,
      true
    );
    return;
  }
  // Rule 2: the effect may have happened -> unknown, lock held for adjudication.
  await admissions.markUnknown(
    cmd.request_id,
    { status_code: 409, code: 'admission_unknown', now },
    deps.db
  );
  const unknown = await admissions.getByRequestId(cmd.request_id, deps.db);
  await sendReplyAndAck(
    deps,
    message,
    cmd,
    {
      status: 409,
      code: 'admission_unknown',
      run_id: unknown?.run_id ?? null,
      cascade_id: unknown?.cascade_id ?? null,
    },
    now,
    true
  );
}

/**
 * Process one queued command row end-to-end. Never throws. Returns false when
 * the row is left queued after a failure (counted toward A5.12's dead-letter).
 */
export async function processCommand(
  deps: CauldronFireConsumerDeps,
  message: DispatchMessage
): Promise<boolean> {
  const now = deps.now().toISOString();
  let ctx: { cmd: T3Command; actor: string; digest: string } | null = null;
  try {
    const validated = await validateCommand(deps, message);
    if (!validated.ok) {
      // Validation failures execute nothing and create no admission row.
      await sendReplyAndAck(deps, message, null, validated.outcome, now, false);
      return true;
    }
    const cmd = validated.cmd;
    const digest = canonicalDigest(cmd);

    // Admission dedupe: replay the original outcome, or refuse a conflicting reuse.
    const existing = await admissions.getByRequestId(cmd.request_id, deps.db);
    if (existing) {
      if (
        existing.payload_sha256 === digest &&
        existing.actor_principal_id === message.sender_principal_id
      ) {
        if (existing.state === 'reserved') {
          // A4.2 / A5.5: Dispatch returns the ORIGINAL row for a same-actor
          // resend, so a reserved admission is only ever re-read through its own
          // source row (e.g. after a restart) or while in flight. Never answer
          // it here -- no reply, no ack; the in-flight handler or stale
          // recovery owns its final reply under reply:<source_message_id>.
          return true;
        }
        // Same request, same actor -> original outcome under this row's reply identity.
        await sendReplyAndAck(deps, message, cmd, replayOutcome(existing), now, false);
        return true;
      }
      // Different digest or different actor -> conflict; original row untouched.
      await sendReplyAndAck(
        deps,
        message,
        cmd,
        { status: 409, code: 'request_conflict' },
        now,
        false
      );
      return true;
    }

    // A5.6: a NEW command older than the max age is refused before admission.
    const rawMaxAge = Number(deps.env.T3_COMMAND_MAX_AGE_S);
    const maxAgeS = Number.isFinite(rawMaxAge) && rawMaxAge > 0 ? rawMaxAge : DEFAULT_MAX_AGE_S;
    const createdMs = parseUtcTimestamp(message.created_at);
    if (Number.isFinite(createdMs) && deps.now().getTime() - createdMs > maxAgeS * 1000) {
      await sendReplyAndAck(deps, message, cmd, { status: 409, code: 'expired' }, now, false);
      return true;
    }

    // Validation guaranteed sender_principal_id is a non-null, allowlisted actor
    // equal to the envelope sender; fall back to sender only to satisfy the type.
    const actor = message.sender_principal_id ?? message.sender;
    ctx = { cmd, actor, digest };
    inFlightRequests.add(cmd.request_id);
    let outcome: ReplyOutcome;
    try {
      if (cmd.verb === 'fire') {
        outcome = await handleFire(deps, cmd, message, actor, now, digest);
      } else if (cmd.verb === 'cancel-own') {
        outcome = await handleCancel(deps, cmd, message, actor, now, digest);
      } else {
        outcome = await handleApprove(deps, cmd, message, actor, now, digest);
      }
    } finally {
      inFlightRequests.delete(cmd.request_id);
    }
    await sendReplyAndAck(deps, message, cmd, outcome, now, true);
    return true;
  } catch (error) {
    if (error instanceof CasLostError) {
      // A5.7: another process owns or resolved this reservation. Abort with no
      // reply and no ack; the owner answers the row.
      log.warn({ messageId: message.id, cause: error.message }, 'cauldron_fire_cas_lost');
      return true;
    }
    log.warn(
      {
        messageId: message.id,
        errorClass: errorClassOf(error),
        cause: (error as Error).message?.slice(0, 200),
      },
      'cauldron_fire_process_failed'
    );
    try {
      if (ctx) {
        await resolveHandlerException(deps, message, ctx.cmd, ctx.actor, ctx.digest, error);
      } else {
        // Threw before an admission could exist (validation / dedupe read):
        // nothing executed. Answer and acknowledge so the row cannot strand.
        await sendReplyAndAck(
          deps,
          message,
          null,
          { status: 503, code: 'failed_before_effect', error_class: errorClassOf(error) },
          now,
          false
        );
      }
      return true;
    } catch (resolveError) {
      // Could not even record/reply (store down, mailbox unresolved): the row
      // stays queued and is retried next tick, where admission dedupe prevents a
      // second effect. Counted toward the A5.12 dead-letter threshold.
      log.error(
        { messageId: message.id, cause: (resolveError as Error).message?.slice(0, 200) },
        'cauldron_fire_exception_unresolved'
      );
      return false;
    }
  }
}

/**
 * Recovery for all three verbs (A2.2 rule 4), run at the start of every tick
 * (and so at startup): every `reserved` admission not updated for
 * T3_COMMAND_RESERVATION_STALE_S seconds (default 300) that no handler in this
 * process holds gets a durable outcome:
 *   effect_started_at null -> refused, 503 failed_before_effect
 *                             (error_class RecoveredBeforeEffect);
 *   effect set and provable -> admitted (fire: run custody; cancel-own: run
 *                             cancelled by this actor; approve: approval_received
 *                             after the marker, code approved_not_resumed);
 *   otherwise               -> unknown, 409 admission_unknown (lock held).
 * It replies under the stranded row's own reply identity
 * (reply:<source_message_id>, so it can never duplicate) and acknowledges it.
 * Recovery NEVER re-executes a verb.
 */
export async function recoverStaleReservations(deps: CauldronFireConsumerDeps): Promise<void> {
  const nowDate = deps.now();
  const now = nowDate.toISOString();
  const raw = Number(deps.env.T3_COMMAND_RESERVATION_STALE_S);
  const staleS = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RESERVATION_STALE_S;
  const cutoff = new Date(nowDate.getTime() - staleS * 1000).toISOString();
  const stale = await admissions.listStaleReservations(cutoff, deps.db);
  for (const row of stale) {
    if (inFlightRequests.has(row.request_id)) continue;
    try {
      let outcome: ReplyOutcome;
      if (!row.effect_started_at) {
        await admissions.markRefused(
          row.request_id,
          { status_code: 503, code: 'failed_before_effect', now },
          deps.db
        );
        outcome = {
          status: 503,
          code: 'failed_before_effect',
          error_class: 'RecoveredBeforeEffect',
        };
      } else {
        outcome = await recoverEffectStarted(deps, row, now);
      }
      const mailbox = deps.resolveActorMailbox(row.actor_principal_id);
      if (mailbox) {
        const reply = await deps.sendReply({
          recipient: mailbox,
          correlationId: row.request_id,
          idempotencyKey: `reply:${row.source_message_id}`,
          body: JSON.stringify({
            schema: REPLY_SCHEMA,
            request_id: row.request_id,
            verb: row.verb,
            status: outcome.status,
            code: outcome.code,
            run_id: outcome.run_id ?? null,
            cascade_id: outcome.cascade_id ?? null,
            thread_id: row.thread_id,
            ...(outcome.error_class ? { error_class: outcome.error_class } : {}),
            ...(outcome.code === 'admission_unknown' ? { message: ADMISSION_UNKNOWN_TEXT } : {}),
          }),
        });
        await admissions.recordReply(row.request_id, reply.id, now, deps.db);
        await deps.acknowledge(row.source_message_id).catch(() => undefined);
      } else {
        // A5.5: no reply row -> no ack; the decided outcome replays when the
        // mailbox resolves (or the row is dead-lettered, A5.12).
        log.error({ requestId: row.request_id }, 'cauldron_fire_recover_mailbox_unresolved');
      }
    } catch (error) {
      log.warn(
        { requestId: row.request_id, cause: (error as Error).message?.slice(0, 200) },
        'cauldron_fire_recover_failed'
      );
    }
  }
}

async function recoverEffectStarted(
  deps: CauldronFireConsumerDeps,
  row: T3CommandAdmissionRow,
  now: string
): Promise<ReplyOutcome> {
  if (row.verb === 'fire') {
    const custody = await deps.proveFireCustody(row);
    if (custody) {
      for (const runId of custody.runIds) {
        await admissions.appendRunCustody(
          { admission_id: row.request_id, run_id: runId, tier: null, now },
          deps.db
        );
      }
      await admissions.markAdmitted(
        row.request_id,
        {
          status_code: 200,
          code: 'ok',
          run_id: custody.runId,
          cascade_id: custody.cascadeId ?? row.cascade_id,
          now,
        },
        deps.db
      );
      return {
        status: 200,
        code: 'ok',
        run_id: custody.runId,
        cascade_id: custody.cascadeId ?? row.cascade_id,
      };
    }
  } else if (row.verb === 'cancel-own' && row.target_run_id) {
    if (await deps.proveCancel(row.target_run_id, row.actor_principal_id)) {
      await admissions.markAdmitted(
        row.request_id,
        { status_code: 200, code: 'ok', run_id: row.target_run_id, now },
        deps.db
      );
      return { status: 200, code: 'ok', run_id: row.target_run_id };
    }
  } else if (row.verb === 'approve' && row.target_run_id && row.effect_started_at) {
    if (await deps.proveApprove(row.target_run_id, row.effect_started_at)) {
      // The approval is proven; whether its resume was dispatched is not.
      await admissions.markAdmitted(
        row.request_id,
        { status_code: 200, code: 'approved_not_resumed', run_id: row.target_run_id, now },
        deps.db
      );
      return { status: 200, code: 'approved_not_resumed', run_id: row.target_run_id };
    }
  }
  await admissions.markUnknown(
    row.request_id,
    { status_code: 409, code: 'admission_unknown', now },
    deps.db
  );
  return {
    status: 409,
    code: 'admission_unknown',
    run_id: row.run_id,
    cascade_id: row.cascade_id,
  };
}

let tickInFlight = false;

/**
 * One clock tick: drain the mailbox sequentially. Never throws. Single-flight
 * (like review-worker-clock's inFlight): a tick that starts while another is
 * still executing -- e.g. a fire awaiting run discovery -- is a no-op, so no
 * second tick can re-read and answer a command whose decision is in progress.
 */
export async function tickCauldronFireConsumer(deps: CauldronFireConsumerDeps): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    // A5.7: only the lease holder ticks (multi-process safety). The lease is
    // renewed before EACH command, never only once per batch.
    const ttlMs = resolveLeaseTtlMs(deps.env);
    const holdLease = (): Promise<boolean> =>
      admissions.acquireConsumerLease(deps.leaseHolder, deps.now().toISOString(), ttlMs, deps.db);
    if (!(await holdLease())) return;
    await recoverStaleReservations(deps).catch((error: unknown) => {
      log.warn({ cause: (error as Error).message?.slice(0, 200) }, 'cauldron_fire_sweep_failed');
    });
    // Release retained WO claims whose runs are all terminal (claim release (c)).
    await reconcileRetainedWoClaims(deps.db).catch((error: unknown) => {
      log.warn(
        { cause: (error as Error).message?.slice(0, 200) },
        'cauldron_fire_claim_reconcile_failed'
      );
    });
    const commands = await deps.listCommands(CAULDRON_FIRE_RECIPIENT, COMMAND_LIST_LIMIT);
    for (const message of commands) {
      if (!(await holdLease())) {
        log.warn({ messageId: message.id }, 'cauldron_fire_lease_lost_mid_batch');
        break;
      }
      const ok = await processCommand(deps, message);
      if (!ok) await countFailureOrDeadLetter(deps, message);
    }
  } catch (error) {
    log.warn({ cause: (error as Error).message.slice(0, 200) }, 'cauldron_fire_tick_failed');
  } finally {
    tickInFlight = false;
  }
}

/**
 * A5.12: count a failed processing attempt; after DEAD_LETTER_ATTEMPTS the row
 * is acknowledged + addressed and one operator message names it.
 */
async function countFailureOrDeadLetter(
  deps: CauldronFireConsumerDeps,
  message: DispatchMessage
): Promise<void> {
  try {
    const attempts = await admissions.recordFailedAttempt(
      message.id,
      'processing_failed',
      deps.now().toISOString(),
      deps.db
    );
    if (attempts < DEAD_LETTER_ATTEMPTS) return;
    await deps.alertOperator({
      subject: 'cauldron-fire command dead-lettered',
      body: JSON.stringify({
        message_id: message.id,
        request_id: (message.idempotency_key ?? '').slice(0, MAX_ECHOED_FIELD_LENGTH),
        sender: message.sender_principal_id ?? null,
        attempts,
      }),
      idempotencyKey: `dead-letter:${message.id}`,
    });
    await deps.acknowledge(message.id);
    log.error({ messageId: message.id, attempts }, 'cauldron_fire_command_dead_lettered');
  } catch (error) {
    log.error(
      { messageId: message.id, cause: (error as Error).message?.slice(0, 200) },
      'cauldron_fire_dead_letter_failed'
    );
  }
}

/**
 * Lease TTL (runbook "Single consumer"): comfortably longer than the longest
 * handler. The longest is a fire, which holds the tick until run discovery:
 * cascade preflight + seat read (<= ~30 s) + prior-run teardown wait
 * (SMART_CAULDRON_TEARDOWN_WAIT_MS, default 180 s) + run discovery (30 s), about
 * 4 minutes. Default 15 minutes (over 3x that); T3_COMMAND_LEASE_TTL_S overrides
 * (never below 3 poll intervals).
 */
export const DEFAULT_LEASE_TTL_S = 900;
export function resolveLeaseTtlMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.T3_COMMAND_LEASE_TTL_S);
  const ttlS = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_TTL_S;
  return Math.max(ttlS * 1000, 3 * resolvePollMs(env));
}

export function resolvePollMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.T3_COMMAND_POLL_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_POLL_MS;
}

export function cauldronFireConsumerEnabled(env: Record<string, string | undefined>): boolean {
  return env.T3_COMMAND_CONSUMER_ENABLED === '1';
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the consumer clock. No-op (no reads, no writes) unless
 * T3_COMMAND_CONSUMER_ENABLED=1. Runs crash recovery once, then an immediate
 * tick, then every T3_COMMAND_POLL_MS.
 */
export function startCauldronFireConsumer(
  deps?: CauldronFireConsumerDeps,
  options: { apiFetch?: typeof fetch } = {}
): void {
  if (timer) return;
  let resolved = deps;
  if (!resolved) {
    if (!cauldronFireConsumerEnabled(process.env)) return;
    if (!options.apiFetch) {
      // Fail closed: production wiring must hand in the server's in-process API
      // dispatcher. Without it a fire could only be an HTTP self-call.
      log.error('cauldron_fire_consumer_in_process_api_missing');
      return;
    }
    resolved = createRealCauldronFireConsumerDeps(process.env, options.apiFetch);
  }
  if (!cauldronFireConsumerEnabled(resolved.env)) return;
  // The first tick runs startup recovery for all verbs (recoverStaleReservations).
  void tickCauldronFireConsumer(resolved);
  timer = setInterval(() => void tickCauldronFireConsumer(resolved), resolvePollMs(resolved.env));
  timer.unref?.();
}

export function stopCauldronFireConsumer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// --------------------------------------------------------------------------
// Real dependencies (production wiring; not exercised by unit tests)
// --------------------------------------------------------------------------

const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * Pending commands for the consumer: queued, not yet acknowledged. Completed
 * commands are acknowledged AND addressed (completeCommandMessage), so they
 * leave the queued page; acknowledged rows are additionally excluded here so a
 * row whose address step failed cannot occupy the LIMIT window forever.
 */
export async function listPendingCommands(
  recipient: string,
  limit: number
): Promise<DispatchMessage[]> {
  const page = await dispatchDb.listMessages({
    recipient,
    status: 'queued',
    limit: limit + COMMAND_LIST_LIMIT,
  });
  const pending = page.filter(row => row.acknowledged_at === null);
  if (pending.length > 0 || page.length === 0) return pending.slice(0, limit);
  // The whole page was acknowledged-but-unaddressed leftovers: heal them
  // (address) so the next page is reachable, then return nothing this tick.
  for (const row of page) await completeCommandMessage(row.id).catch(() => undefined);
  return [];
}

/**
 * Durably complete a command row once its reply exists: acknowledge, then
 * address it as cauldron-fire. listMessages(status='queued') excludes addressed
 * rows, so a completed command never re-enters the polling page. Both steps
 * are idempotent for the same principal.
 */
export async function completeCommandMessage(messageId: string): Promise<void> {
  const acked = await dispatchDb.acknowledgeMessage({
    id: messageId,
    principal_id: CAULDRON_FIRE_RECIPIENT,
  });
  if (!acked.ok) throw new Error(`cauldron_fire_ack_failed:${acked.reason}`);
  const addressed = await dispatchDb.addressMessage({
    id: messageId,
    principal_id: CAULDRON_FIRE_RECIPIENT,
  });
  if (!addressed.ok) throw new Error(`cauldron_fire_address_failed:${addressed.reason}`);
}

/**
 * Run the cascade, but return as soon as the first run id is DISCOVERED (the
 * dispatch is proven), not after terminal-state polling. The caller persists
 * authenticated ownership (admitted + run_id) immediately, so cancel-own and
 * approve work while the run is running or paused. The cascade keeps running
 * in the background. If the cascade ends before any run is discovered, its
 * final record decides the outcome exactly as before.
 */
export async function fireCascadeUntilRunDiscovered(
  runCascadeImpl: typeof runCascade,
  readRecord: typeof readCascadeRecord,
  options: Parameters<typeof runCascade>[0],
  onEachRun?: (runId: string, tier: string | null) => void
): Promise<{ cascadeId: string; status: string; runId: string | null }> {
  let discovered: ((value: { runId: string; cascadeId: string }) => void) | null = null;
  const runDiscovered = new Promise<{ runId: string; cascadeId: string }>(resolve => {
    discovered = resolve;
  });
  const cascade = runCascadeImpl({
    ...options,
    // Fires once PER run on every tier (Amendment 3): custody is appended for
    // each; the first discovery also completes the fire admission.
    onRunDiscovered: (runId, cascadeId, tierName) => {
      try {
        onEachRun?.(runId, tierName ?? null);
      } catch {
        // Custody observation only; never alters the cascade.
      }
      discovered?.({ runId, cascadeId });
    },
  });
  const first = await Promise.race([
    runDiscovered.then(found => ({ kind: 'run' as const, found })),
    cascade.then(record => ({ kind: 'done' as const, record })),
  ]);
  if (first.kind === 'run') {
    void cascade.catch((error: unknown) => {
      log.warn(
        { cascadeId: first.found.cascadeId, cause: (error as Error).message.slice(0, 200) },
        'cauldron_fire_background_cascade_failed'
      );
    });
    return { cascadeId: first.found.cascadeId, status: 'running', runId: first.found.runId };
  }
  const record = first.record;
  const persisted = await readRecord(record.cascadeId);
  const runId =
    persisted?.attempts.find(attempt => attempt.runId)?.runId ??
    record.attempts.find(attempt => attempt.runId)?.runId ??
    null;
  return { cascadeId: record.cascadeId, status: record.status, runId };
}

/**
 * The consumer's approve (A2.1): the SAME pair the HTTP approve route uses --
 * approvePausedWorkflowRun followed by tryAutoResumeRun(run, 'approve'). Never a
 * no-op resume and never the /resume route.
 */
export async function approveRunWithResume(
  runId: string,
  opts: {
    comment: string;
    decisionVerb: 'approve_as_is';
    authorizedFixIds: string[];
    expectedNodeId: string;
  }
): Promise<ApprovePausedWorkflowRunResult> {
  const api = await import('../routes/api');
  return api.approvePausedWorkflowRun(runId, {
    ...opts,
    autoResume: run => api.tryAutoResumeRun(run, 'approve'),
  });
}

/** Maps a GitHub pulls API body to the PR identity approve binds (A5.15: testable). */
export function mapPullRequest(pr: {
  state: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } | null };
}): PullRequestIdentity {
  return {
    open: pr.state === 'open',
    headRepo: pr.head.repo ? normalizeRepo(pr.head.repo.full_name) : '',
    baseRepo: pr.base.repo ? normalizeRepo(pr.base.repo.full_name) : '',
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    headSha: pr.head.sha,
  };
}

/** A5.10: whole-second UTC comparison of a stored event time against a marker. */
function atOrAfterSecond(eventTime: string | Date | null | undefined, markerIso: string): boolean {
  const eventMs = parseUtcTimestamp(eventTime ?? null);
  const markerMs = parseUtcTimestamp(markerIso);
  if (!Number.isFinite(eventMs) || !Number.isFinite(markerMs)) return false;
  return Math.floor(eventMs / 1000) >= Math.floor(markerMs / 1000);
}

/**
 * A5.3(b): a run naming the WO is live when non-terminal, or `failed` as an
 * approval hand-off within the A5.9 bound. Exported for the real-deps tests.
 */
export async function findLiveRunForWo(
  db: IDatabase,
  woId: string,
  env: Record<string, string | undefined>,
  nowMs: number
): Promise<{ live: boolean; runId: string | null }> {
  const statuses = [...NON_TERMINAL_RUN_STATUSES, 'failed'];
  const placeholders = statuses.map((_, index) => `$${index + 2}`).join(',');
  const result = await db.query<{ id: string; user_message: string; status: string }>(
    `SELECT id, user_message, status FROM remote_agent_workflow_runs
     WHERE user_message LIKE $1 AND status IN (${placeholders})`,
    [`%${woId}%`, ...statuses]
  );
  for (const row of result.rows) {
    if (!userMessageNamesWo(row.user_message, woId)) continue;
    if (row.status !== 'failed') return { live: true, runId: row.id };
    const events = await workflowEventsDb.listWorkflowEvents(row.id);
    const handOff = isApprovalHandOff(
      {
        run: { status: row.status },
        events: events.map(event => ({
          event_type: event.event_type,
          created_at: event.created_at as unknown as string,
        })),
      },
      { nowMs, maxAgeS: approvalHandOffBoundS(env) }
    );
    if (handOff) return { live: true, runId: row.id };
  }
  return { live: false, runId: null };
}

export function createRealCauldronFireConsumerDeps(
  env: Record<string, string | undefined>,
  apiFetch: typeof fetch
): CauldronFireConsumerDeps {
  async function githubToken(): Promise<string> {
    const identity = resolveServiceGitHubAuth('taskmaster', env);
    if (identity.kind === 'none') throw new Error('cauldron_fire_github_token_missing');
    const token = await getServiceGitHubToken(identity, { apiBaseUrl: GITHUB_API_ORIGIN });
    if (!token) throw new Error('cauldron_fire_github_token_missing');
    return token;
  }

  const leaseHolder = `${hostname()}:${process.pid}:${randomUUID()}`;
  return {
    env,
    now: (): Date => new Date(),
    db: getDatabase(),
    listCommands: (recipient, limit) => listPendingCommands(recipient, limit),
    sendReply: (input): Promise<DispatchMessage> =>
      dispatchDb.createAuthenticatedMessage(
        { kind: 'system', sender: 'cauldron-fire' },
        {
          task_type: 'agent_message',
          recipient: input.recipient,
          correlation_id: input.correlationId,
          idempotency_key: input.idempotencyKey,
          body: input.body,
        }
      ),
    acknowledge: (messageId): Promise<void> => completeCommandMessage(messageId),
    resolveActorMailbox: (principalOrSender): string | null => {
      try {
        const registry = parseDispatchPrincipalsRegistry(env.DISPATCH_PRINCIPALS_JSON);
        const credential = registry.find(
          entry => entry.principal_id === principalOrSender && entry.status === 'active'
        );
        return credential?.receive_as[0] ?? null;
      } catch {
        return null;
      }
    },
    resolveProjectRepository: async (project): Promise<string | null | undefined> => {
      const codebases = await codebasesDb.listCodebases();
      // Bare repo names ('bdc-xo') resolve to the unique owner/repo codebase, the
      // same naming fire-eligibility uses (bdc-xo#4311 Test 10).
      const match = matchProjectCodebase(codebases, project);
      if (!match) return undefined;
      return match.repository_url ? normalizeRepo(match.repository_url) : null;
    },
    hasLiveWorkflowRun: (woId): Promise<{ live: boolean; runId: string | null }> =>
      findLiveRunForWo(getDatabase(), woId, env, Date.now()),
    checkFireEligibility: async (
      issueTitle
    ): ReturnType<CauldronFireConsumerDeps['checkFireEligibility']> => {
      const result = await checkFireEligibilityImpl(issueTitle);
      return {
        eligible: result.eligible,
        reason: result.reason,
        evidence: result.evidence
          ? {
              woId: result.evidence.woId,
              project: result.evidence.project,
              expectedSpec: result.evidence.expectedSpec,
            }
          : undefined,
      };
    },
    fireCascade: async (
      input
    ): Promise<{ cascadeId: string; status: string; runId: string | null }> => {
      const entryOverride =
        input.lane === 'cursor' || input.lane === 'zero' ? input.lane : undefined;
      return fireCascadeUntilRunDiscovered(
        runCascade,
        readCascadeRecord,
        {
          woId: input.woId,
          project: input.project,
          dispatchId: input.dispatchId,
          // A5.2: the spec revision eligibility verified is pinned for the build.
          expectedSpec: input.expectedSpec as Parameters<typeof runCascade>[0]['expectedSpec'],
          // A5.0: the shared database WO claim (also passed by Taskmaster).
          deps: { ...cascadeWoClaimDeps(`t3:${leaseHolder}`) },
          // Trust boundary (WO-HARNESS-T3-COMMAND-CONSUMER-01 runbook): the T3
          // command consumer fires on behalf of an authenticated ACTOR, never the
          // operator. It must NOT carry the operator token. Pass an explicit empty
          // token so runCascade does not fall back to process.env.ARCHON_OPERATOR_TOKEN
          // (`token ?? env` only falls back on null/undefined, so '' short-circuits it).
          token: '',
          // Authenticated in-process execution: every Archon API call the cascade
          // makes (codebase lookup, conversation dispatch, run discovery, poll,
          // node timeouts, cancel, seat read) is dispatched into this server's own
          // router by createInProcessApiFetch under the in-process service
          // authority. No socket, no HTTP self-call, no operator token.
          apiBaseUrl: IN_PROCESS_API_ORIGIN,
          fetchImpl: apiFetch,
          // A2.1 item 5 / A5.9: an approval's `failed` hand-off is not a terminal
          // failure -- for the bounded window only.
          isTransitionalStatus: detail =>
            isApprovalHandOff(detail, { nowMs: Date.now(), maxAgeS: approvalHandOffBoundS(env) }),
          entryOverride,
        },
        input.onRunDiscovered
      );
    },
    knownLanes: ['cursor', 'zero'],
    cancelRun: async (runId, opts): Promise<CancelWorkflowRunActorResult> => {
      const api = await import('../routes/api');
      return api.cancelWorkflowRunAsActor(runId, opts);
    },
    approveRun: (runId, opts): Promise<ApprovePausedWorkflowRunResult> =>
      approveRunWithResume(runId, opts),
    proveFireCustody: async (
      row
    ): Promise<{ runId: string; cascadeId: string | null; runIds: string[] } | null> => {
      const record = await readCascadeRecord(row.cascade_id ?? row.request_id);
      const runIds = (record?.attempts ?? [])
        .map(attempt => attempt.runId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const runId = runIds[0] ?? null;
      if (!runId || !row.wo_id) return null;
      const run = await workflowsDb.getWorkflowRun(runId);
      if (!run || !userMessageNamesWo(run.user_message ?? '', row.wo_id)) return null;
      return { runId, cascadeId: record?.cascadeId ?? row.cascade_id, runIds };
    },
    readCascadeRunIds: async (cascadeId): Promise<string[]> => {
      const record = await readCascadeRecord(cascadeId);
      return (record?.attempts ?? [])
        .map(attempt => attempt.runId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    },
    proveCancel: async (runId, actor): Promise<boolean> => {
      const run = await workflowsDb.getWorkflowRun(runId);
      if (run?.status !== 'cancelled') return false;
      const events = await workflowEventsDb.listWorkflowEvents(runId);
      return events.some(
        event => event.event_type === 'run_cancelled' && event.data.actor === actor
      );
    },
    proveApprove: async (runId, sinceIso): Promise<boolean> => {
      // A5.10: SQLite event times are second-resolution UTC without a zone.
      const events = await workflowEventsDb.listWorkflowEvents(runId);
      return events.some(
        event =>
          event.event_type === 'approval_received' &&
          atOrAfterSecond(event.created_at as unknown as string, sinceIso)
      );
    },
    getRunApproval: async (
      runId
    ): Promise<{ nodeId: string; type: string | null; captureResponse: boolean } | null> => {
      const run = await workflowsDb.getWorkflowRun(runId);
      const approval = run?.metadata.approval as
        | { nodeId?: unknown; type?: unknown; captureResponse?: unknown }
        | undefined;
      if (run?.status !== 'paused' || typeof approval?.nodeId !== 'string') return null;
      return {
        nodeId: approval.nodeId,
        type: typeof approval.type === 'string' ? approval.type : null,
        captureResponse: approval.captureResponse === true,
      };
    },
    findRunsForWoSince: async (woId, sinceIso): Promise<string[]> => {
      const statuses = [...NON_TERMINAL_RUN_STATUSES];
      const placeholders = statuses.map((_, index) => `$${index + 2}`).join(',');
      const result = await getDatabase().query<{
        id: string;
        user_message: string;
        started_at: string;
      }>(
        `SELECT id, user_message, started_at FROM remote_agent_workflow_runs
         WHERE user_message LIKE $1 AND status IN (${placeholders})`,
        [`%${woId}%`, ...statuses]
      );
      return result.rows
        .filter(
          row =>
            userMessageNamesWo(row.user_message, woId) && atOrAfterSecond(row.started_at, sinceIso)
        )
        .map(row => row.id);
    },
    alertOperator: async (input): Promise<void> => {
      await dispatchDb.createAuthenticatedMessage(
        { kind: 'system', sender: 'cauldron-fire' },
        {
          task_type: 'agent_message',
          recipient: 'operator',
          correlation_id: input.idempotencyKey,
          idempotency_key: input.idempotencyKey,
          body: JSON.stringify({ subject: input.subject, detail: input.body }),
        }
      );
    },
    leaseHolder,
    getRunRepository: async (runId): Promise<string | null> => {
      const run = await workflowsDb.getWorkflowRun(runId);
      if (!run?.codebase_id) return null;
      const codebases = await codebasesDb.listCodebases();
      const match = codebases.find(entry => entry.id === run.codebase_id);
      return match?.repository_url ? normalizeRepo(match.repository_url) : null;
    },
    getRunBranch: async (runId): Promise<string | null> => {
      const authority = await workflowsDb.getRunAuthority(runId);
      return authority?.headBranch ?? null;
    },
    getPullRequest: async (repo, number): Promise<PullRequestIdentity | null> => {
      const token = await githubToken();
      const response = await fetch(`${GITHUB_API_ORIGIN}/repos/${repo}/pulls/${number}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'bdc-harness-cauldron-fire',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`cauldron_fire_github_${response.status}`);
      return mapPullRequest((await response.json()) as Parameters<typeof mapPullRequest>[0]);
    },
  };
}
