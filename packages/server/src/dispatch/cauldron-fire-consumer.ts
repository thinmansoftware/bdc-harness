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
import { parseDispatchPrincipalsRegistry } from '@archon/core/db/dispatch-sender-authority';
import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
} from '@archon/core/github/service-identity';
import { runCascade, readCascadeRecord } from '@archon/smart-cauldron/cascade';
import * as admissions from '@archon/core/db/t3-command-admissions';
import type { T3CommandAdmissionRow, T3CommandVerb } from '@archon/core/db/t3-command-admissions';
import { checkFireEligibility as checkFireEligibilityImpl } from '../taskmaster/fire-eligibility';
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
  thread_id?: string;
}

export interface ReplyOutcome {
  status: number;
  code: string;
  run_id?: string | null;
  cascade_id?: string | null;
}

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
  checkFireEligibility: (issueTitle: string) => Promise<{ eligible: boolean; reason?: string }>;
  fireCascade: (input: {
    woId: string;
    project: string;
    lane?: string;
    dispatchId: string;
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
    opts: { comment: string; decisionVerb: 'approve_as_is'; authorizedFixIds: string[] }
  ) => Promise<ApprovePausedWorkflowRunResult>;

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
    thread_id: typeof body.thread_id === 'string' ? body.thread_id : undefined,
  };

  // Per-verb required fields.
  if (verb === 'fire' && !cmd.wo_id) {
    return { ok: false, outcome: { status: 400, code: 'wo_id_missing' } };
  }
  if (verb === 'cancel-own' && !cmd.run_id) {
    return { ok: false, outcome: { status: 400, code: 'run_id_missing' } };
  }
  if (verb === 'approve') {
    if (!cmd.run_id_for_approve || !cmd.pr || !cmd.head_sha) {
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
  // Live-run refusal: another fire admission for this WO is mid-admission
  // (reserved). A completed `admitted` row does not block -- that run's liveness
  // is owned by hasLiveWorkflowRun above, not by the admission ledger.
  const competitor = await admissions.findLiveFireForWo(woId, cmd.request_id, deps.db);
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
  if (!eligibility.eligible) {
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 409, code: `fire_ineligible:${eligibility.reason ?? 'unknown'}`, now },
      deps.db
    );
    return { status: 409, code: `fire_ineligible:${eligibility.reason ?? 'unknown'}` };
  }

  let result: { cascadeId: string; status: string; runId: string | null };
  try {
    result = await deps.fireCascade({
      woId,
      project: cmd.project,
      lane: cmd.lane,
      dispatchId: cmd.request_id,
    });
  } catch (error) {
    // The cascade invocation threw before returning a result. We cannot prove
    // whether a run was created, so releasing the WO (markRefused) risks a
    // double-fire once any created run completes. Reconcile as `unknown`: the
    // actor is told admission_unknown and the fire is NEVER refired automatically
    // (startup recovery / operator adjudicates instead).
    log.warn(
      { woId, cause: (error as Error).message.slice(0, 200) },
      'cauldron_fire_cascade_failed'
    );
    await admissions
      .markUnknown(cmd.request_id, { status_code: 500, code: 'fire_failed', now }, deps.db)
      .catch(() => undefined);
    return { status: 500, code: 'fire_failed' };
  }

  // Command contract: a fire is only `ok` when it yields a verifiable run id
  // (custody of a specific run). A cascade that returns no run id cannot be
  // confirmed, so it is NOT replied as success -- record it as `unknown` so it
  // is never reported ok and never refired automatically.
  if (!result.runId) {
    log.warn({ woId, cascadeId: result.cascadeId }, 'cauldron_fire_no_run_id');
    await admissions
      .markUnknown(cmd.request_id, { status_code: 502, code: 'fire_no_run', now }, deps.db)
      .catch(() => undefined);
    return { status: 502, code: 'fire_no_run', cascade_id: result.cascadeId };
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
    // (best effort; if even that write fails the row stays `reserved` and startup
    // recovery marks it unknown) so the executed cascade is preserved, never refired.
    log.warn(
      { woId, runId: result.runId, cause: (error as Error).message.slice(0, 200) },
      'cauldron_fire_admit_persist_failed'
    );
    await admissions
      .markUnknown(
        cmd.request_id,
        { status_code: 500, code: 'fire_admit_unpersisted', now },
        deps.db
      )
      .catch(() => undefined);
    return {
      status: 500,
      code: 'fire_admit_unpersisted',
      run_id: result.runId,
      cascade_id: result.cascadeId,
    };
  }
  return { status: 200, code: 'ok', run_id: result.runId, cascade_id: result.cascadeId };
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
  const reserved = await admissions.reserveAdmission(
    {
      request_id: cmd.request_id,
      actor_principal_id: actor,
      verb: 'cancel-own',
      payload_sha256: digest,
      wo_id: cmd.wo_id ?? null,
      project: cmd.project,
      target_run_id: runId,
      thread_id: cmd.thread_id ?? null,
      source_message_id: message.id,
      now,
    },
    deps.db
  );
  if (reserved.status === 'exists') return replayOutcome(reserved.row);

  if (!(await admissions.ownsRun(actor, runId, deps.db))) {
    await admissions.markRefused(
      cmd.request_id,
      { status_code: 403, code: 'forbidden_not_own_run', now },
      deps.db
    );
    return { status: 403, code: 'forbidden_not_own_run' };
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
  const reserved = await admissions.reserveAdmission(
    {
      request_id: cmd.request_id,
      actor_principal_id: actor,
      verb: 'approve',
      payload_sha256: digest,
      wo_id: cmd.wo_id ?? null,
      project: cmd.project,
      target_run_id: runId,
      pr_ref: cmd.pr ?? null,
      head_sha: cmd.head_sha ?? null,
      thread_id: cmd.thread_id ?? null,
      source_message_id: message.id,
      now,
    },
    deps.db
  );
  if (reserved.status === 'exists') return replayOutcome(reserved.row);

  const refuse = async (status: number, code: string): Promise<ReplyOutcome> => {
    await admissions.markRefused(cmd.request_id, { status_code: status, code, now }, deps.db);
    return { status, code };
  };

  // (i) OWNERSHIP: the actor must have fired this run through this consumer.
  if (!(await admissions.ownsRun(actor, runId, deps.db))) {
    return refuse(403, 'forbidden_not_own_run');
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

  const result = await deps.approveRun(runId, {
    comment: 'T3 approve',
    decisionVerb: 'approve_as_is',
    authorizedFixIds: [],
  });
  if (!result.ok) {
    return refuse(result.status, 'approve_refused');
  }
  await admissions.markAdmitted(
    cmd.request_id,
    { status_code: 200, code: 'ok', run_id: runId, now },
    deps.db
  );
  return { status: 200, code: 'ok', run_id: runId };
}

// --------------------------------------------------------------------------
// Per-command processing + tick
// --------------------------------------------------------------------------

async function sendReplyAndAck(
  deps: CauldronFireConsumerDeps,
  message: DispatchMessage,
  cmd: T3Command | null,
  outcome: ReplyOutcome,
  now: string,
  recordOnAdmission: boolean
): Promise<void> {
  const requestId = cmd?.request_id ?? message.correlation_id ?? message.idempotency_key;
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
    log.warn(
      { sender: message.sender, principal: message.sender_principal_id },
      'cauldron_fire_reply_mailbox_unresolved'
    );
  }
  await deps.acknowledge(message.id);
}

/** Process one queued command row end-to-end. Never throws. */
export async function processCommand(
  deps: CauldronFireConsumerDeps,
  message: DispatchMessage
): Promise<void> {
  const now = deps.now().toISOString();
  try {
    const validated = await validateCommand(deps, message);
    if (!validated.ok) {
      // Validation failures execute nothing and create no admission row.
      await sendReplyAndAck(deps, message, null, validated.outcome, now, false);
      return;
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
        // Same request, same actor -> original outcome under this row's reply identity.
        await sendReplyAndAck(deps, message, cmd, replayOutcome(existing), now, false);
        return;
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
      return;
    }

    // Validation guaranteed sender_principal_id is a non-null, allowlisted actor
    // equal to the envelope sender; fall back to sender only to satisfy the type.
    const actor = message.sender_principal_id ?? message.sender;
    let outcome: ReplyOutcome;
    if (cmd.verb === 'fire') {
      outcome = await handleFire(deps, cmd, message, actor, now, digest);
    } else if (cmd.verb === 'cancel-own') {
      outcome = await handleCancel(deps, cmd, message, actor, now, digest);
    } else {
      outcome = await handleApprove(deps, cmd, message, actor, now, digest);
    }
    await sendReplyAndAck(deps, message, cmd, outcome, now, true);
  } catch (error) {
    // A crash between steps is safe: a reserved fire left behind is reconciled
    // to `unknown` at startup, never refired. Do not ack here -- the row stays
    // queued and is reprocessed (admission dedupe prevents a second effect).
    log.error(
      { messageId: message.id, cause: (error as Error).message.slice(0, 200) },
      'cauldron_fire_process_failed'
    );
  }
}

/**
 * Crash recovery: a fire reserved before a crash whose cascade cannot be proven
 * is marked `unknown`, replied 409 admission_unknown, and NEVER refired. Run
 * once at startup only -- a freshly reserved in-flight fire must not be swept.
 */
export async function recoverReservedFires(deps: CauldronFireConsumerDeps): Promise<void> {
  const now = deps.now().toISOString();
  const reserved = await admissions.listReservedFires(deps.db);
  for (const row of reserved) {
    try {
      await admissions.markUnknown(
        row.request_id,
        { status_code: 409, code: 'admission_unknown', now },
        deps.db
      );
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
            status: 409,
            code: 'admission_unknown',
            run_id: null,
            cascade_id: null,
            thread_id: row.thread_id,
          }),
        });
        await admissions.recordReply(row.request_id, reply.id, now, deps.db);
      }
      await deps.acknowledge(row.source_message_id).catch(() => undefined);
    } catch (error) {
      log.warn(
        { requestId: row.request_id, cause: (error as Error).message.slice(0, 200) },
        'cauldron_fire_recover_failed'
      );
    }
  }
}

/** One clock tick: drain the mailbox sequentially. Never throws. */
export async function tickCauldronFireConsumer(deps: CauldronFireConsumerDeps): Promise<void> {
  try {
    const commands = await deps.listCommands(CAULDRON_FIRE_RECIPIENT, COMMAND_LIST_LIMIT);
    for (const message of commands) {
      await processCommand(deps, message);
    }
  } catch (error) {
    log.warn({ cause: (error as Error).message.slice(0, 200) }, 'cauldron_fire_tick_failed');
  }
}

export function resolvePollMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.T3_COMMAND_POLL_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_POLL_MS;
}

export function cauldronFireConsumerEnabled(env: Record<string, string | undefined>): boolean {
  return env.T3_COMMAND_CONSUMER_ENABLED === '1';
}

let timer: ReturnType<typeof setInterval> | null = null;
let recovered = false;

/**
 * Start the consumer clock. No-op (no reads, no writes) unless
 * T3_COMMAND_CONSUMER_ENABLED=1. Runs crash recovery once, then an immediate
 * tick, then every T3_COMMAND_POLL_MS.
 */
export function startCauldronFireConsumer(deps?: CauldronFireConsumerDeps): void {
  if (timer) return;
  const resolved = deps ?? createRealCauldronFireConsumerDeps();
  if (!cauldronFireConsumerEnabled(resolved.env)) return;
  void (async (): Promise<void> => {
    if (!recovered) {
      recovered = true;
      await recoverReservedFires(resolved).catch(() => undefined);
    }
    await tickCauldronFireConsumer(resolved);
  })();
  timer = setInterval(() => void tickCauldronFireConsumer(resolved), resolvePollMs(resolved.env));
  timer.unref?.();
}

export function stopCauldronFireConsumer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  recovered = false;
}

// --------------------------------------------------------------------------
// Real dependencies (production wiring; not exercised by unit tests)
// --------------------------------------------------------------------------

const GITHUB_API_ORIGIN = 'https://api.github.com';

export function createRealCauldronFireConsumerDeps(
  env: Record<string, string | undefined> = process.env
): CauldronFireConsumerDeps {
  async function githubToken(): Promise<string> {
    const identity = resolveServiceGitHubAuth('taskmaster', env);
    if (identity.kind === 'none') throw new Error('cauldron_fire_github_token_missing');
    const token = await getServiceGitHubToken(identity, { apiBaseUrl: GITHUB_API_ORIGIN });
    if (!token) throw new Error('cauldron_fire_github_token_missing');
    return token;
  }

  return {
    env,
    now: (): Date => new Date(),
    db: getDatabase(),
    listCommands: (recipient, limit) =>
      dispatchDb.listMessages({ recipient, status: 'queued', limit }),
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
    acknowledge: async (messageId): Promise<void> => {
      await dispatchDb.acknowledgeMessage({ id: messageId, principal_id: CAULDRON_FIRE_RECIPIENT });
    },
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
      const match = codebases.find(entry => entry.name === project);
      if (!match) return undefined;
      return match.repository_url ? normalizeRepo(match.repository_url) : null;
    },
    hasLiveWorkflowRun: async (woId): Promise<{ live: boolean; runId: string | null }> => {
      const result = await getDatabase().query<{ id: string; user_message: string }>(
        `SELECT id, user_message FROM remote_agent_workflow_runs
         WHERE status IN ('pending','running','paused') AND user_message LIKE $1`,
        [`%${woId}%`]
      );
      for (const row of result.rows) {
        if (userMessageNamesWo(row.user_message, woId)) {
          return { live: true, runId: row.id };
        }
      }
      return { live: false, runId: null };
    },
    checkFireEligibility: async (issueTitle): Promise<{ eligible: boolean; reason?: string }> => {
      const result = await checkFireEligibilityImpl(issueTitle);
      return { eligible: result.eligible, reason: result.reason };
    },
    fireCascade: async (
      input
    ): Promise<{ cascadeId: string; status: string; runId: string | null }> => {
      const entryOverride =
        input.lane === 'cursor' || input.lane === 'zero' ? input.lane : undefined;
      const record = await runCascade({
        // Trust boundary (WO-HARNESS-T3-COMMAND-CONSUMER-01 runbook): the T3
        // command consumer fires on behalf of an authenticated ACTOR, never the
        // operator. It must NOT carry the operator token. Pass an explicit empty
        // token so runCascade does not fall back to process.env.ARCHON_OPERATOR_TOKEN
        // (`token ?? env` only falls back on null/undefined, so '' short-circuits it).
        token: '',
        woId: input.woId,
        project: input.project,
        dispatchId: input.dispatchId,
        entryOverride,
      });
      const persisted = await readCascadeRecord(record.cascadeId);
      const runId =
        persisted?.attempts.find(attempt => attempt.runId)?.runId ??
        record.attempts.find(attempt => attempt.runId)?.runId ??
        null;
      return { cascadeId: record.cascadeId, status: record.status, runId };
    },
    knownLanes: ['cursor', 'zero'],
    cancelRun: async (runId, opts): Promise<CancelWorkflowRunActorResult> => {
      const api = await import('../routes/api');
      return api.cancelWorkflowRunAsActor(runId, opts);
    },
    approveRun: async (runId, opts): Promise<ApprovePausedWorkflowRunResult> => {
      const api = await import('../routes/api');
      return api.approvePausedWorkflowRun(runId, {
        ...opts,
        autoResume: async (): Promise<boolean> => false,
      });
    },
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
      const pr = (await response.json()) as {
        state: string;
        head: { ref: string; sha: string; repo: { full_name: string } | null };
        base: { ref: string; repo: { full_name: string } | null };
      };
      return {
        open: pr.state === 'open',
        headRepo: pr.head.repo ? normalizeRepo(pr.head.repo.full_name) : '',
        baseRepo: pr.base.repo ? normalizeRepo(pr.base.repo.full_name) : '',
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        headSha: pr.head.sha,
      };
    },
  };
}
