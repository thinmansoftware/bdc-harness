/**
 * pr-repair-owner.ts -- the owner that decides WHEN a lane-built PR is repaired
 * in place, collapses duplicate lane PRs to a single survivor, and surfaces
 * exhausted/judgment cases as one Duty Officer digest line.
 *
 * WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01.
 *
 * John's 2026-08-28 ruling: the Overseer JUDGES a rejected PR and hands it back;
 * TASKMASTER decides what actually fires. This module is that decision. It runs
 * once per Taskmaster tick (only while pause_state is RUNNING) and performs
 * three bounded steps:
 *
 *  (1) DEDUPE SWEEP. Over at most MAX_DEDUPE_WOS_PER_TICK work orders that have
 *      two or more lane-created PRs within PR_REPAIR_DEDUPE_WINDOW_HOURS, choose
 *      a survivor (newest OPEN APPROVED, else newest OPEN) and close every OTHER
 *      OPEN lane PR that is not APPROVED with a superseded comment. Branches are
 *      NEVER deleted. An APPROVED non-survivor is never closed; it becomes a
 *      `dedupe_needs_human` digest line.
 *
 *  (2) REPAIR. Read queued lane_repair candidate rows addressed to Taskmaster.
 *      For at most MAX_REPAIR_FIRES_PER_TICK of them, re-prove the LANE PR RULE,
 *      refuse a non-survivor, require the PR OPEN at the reviewed head, skip while
 *      a run for the WO is still running, then fire exactly ONE bounded repair
 *      cascade on the PR's own branch.
 *
 *  (3) EXHAUSTED. Turn each queued overseer_remediation_exhausted row into one
 *      digest line; the caller addresses those rows AFTER the digest carrying
 *      them is sent (commitExhausted), so a failed digest never loses the line.
 *
 * Every external effect is an INJECTED seam, so the owner's whole decision tree
 * runs in tests with no network and no real GitHub writes.
 */
import type {
  LanePr,
  LanePrFetcher,
  WoWithMultipleLanePrs,
} from '@archon/core/db/lane-pr-registry';

/** Default dedupe lookback window (hours). Overridable via env. */
export const PR_REPAIR_DEDUPE_WINDOW_HOURS_DEFAULT = 168;
/** At most one repair cascade is fired per tick -- the bounded-fire contract. */
export const MAX_REPAIR_FIRES_PER_TICK = 1;
/** At most this many duplicate-PR work orders are swept per tick. */
export const MAX_DEDUPE_WOS_PER_TICK = 5;

/** The runbook every automated close comment points a human at. */
export const PR_REPAIR_RUNBOOK_PATH = 'docs/operations/pr-repair-owner.md';

/** A queued dispatch row as the owner needs to read it. */
export interface PrRepairQueuedMessage {
  id: string;
  body: string;
}

/** The lane_repair candidate body fields the owner acts on. */
interface LaneRepairCandidate {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  woId: string;
  headRef: string;
  verdictBody: string;
  workflowName: string | null;
}

/** The exhausted/judgment body fields the owner digests. */
interface ExhaustedRow {
  owner: string;
  repo: string;
  prNumber: number;
  woId: string;
  reason: string;
}

/** Fire one bounded repair cascade. Structurally compatible with runCascade. */
export type PrRepairFireCascade = (opts: {
  woId: string;
  project: string;
  entryOverride?: string;
  initialPriorContext?: string | null;
  repair: { prNumber: number; headRef: string; attemptId: string };
  dispatchId?: string;
  token?: string;
  onAdmission?: (record: { cascadeId: string }) => void;
}) => Promise<{ cascadeId: string }>;

export interface PrRepairOwnerDeps {
  /** Clock seam (ms). Defaults to Date.now. */
  now?: () => number;
  /** Dedupe lookback window in hours. Defaults to PR_REPAIR_DEDUPE_WINDOW_HOURS_DEFAULT. */
  dedupeWindowHours?: number;
  /** GitHub PR fetcher (injected; no implicit network). */
  fetchPr: LanePrFetcher;
  /** WOs with 2+ lane-created PRs within the window. */
  listWosWithMultipleLanePrs: (opts: {
    fetchPr: LanePrFetcher;
    withinHours?: number;
    now?: () => number;
  }) => Promise<WoWithMultipleLanePrs[]>;
  /** Every lane-created PR for one WO. */
  listLanePrsForWo: (
    woId: string,
    opts: { fetchPr: LanePrFetcher; now?: () => number }
  ) => Promise<LanePr[]>;
  /** Queued lane_repair candidate + exhausted rows addressed to Taskmaster. */
  listQueuedTaskmasterMessages: () => Promise<PrRepairQueuedMessage[]>;
  /** Acknowledge a queued row as 'taskmaster'. */
  acknowledgeRow: (id: string) => Promise<void>;
  /** Address a queued row as 'taskmaster', recording a short note. */
  addressRow: (id: string, note: string) => Promise<void>;
  /** Close ONE OPEN non-survivor PR with a comment. Never deletes its branch. */
  closePr: (input: {
    owner: string;
    repo: string;
    prNumber: number;
    comment: string;
  }) => Promise<void>;
  /** True while any run for this WO is still running. */
  hasRunningRunForWo: (woId: string) => Promise<boolean>;
  /** Fire exactly one bounded repair cascade. */
  fireRepairCascade: PrRepairFireCascade;
  /** Map a registry run's workflow_name to its ladder tier; default 'claude'. */
  resolveEntryTier?: (workflowName: string | null) => string | undefined;
  /** Operator token forwarded to the cascade (optional). */
  token?: string;
  /** Structured log seam (optional). */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface PrRepairOwnerResult {
  /** One line per exhausted/judgment case, for the daily digest. */
  digestItems: string[];
  /** Number of non-survivor PRs closed by the dedupe sweep. */
  closedPrs: number;
  /** Number of repair cascades fired (0 or 1). */
  repairsFired: number;
  /** Queued exhausted row ids awaiting their digest line to be sent. */
  exhaustedRowIds: string[];
  /**
   * Address the exhausted rows that produced this tick's digest items. The
   * caller invokes this ONLY after the digest is sent, so a failed digest never
   * drops the line (the row stays queued for the next tick). Idempotent.
   */
  commitExhausted: () => Promise<void>;
}

/** The exact superseded close comment -- asserted character-for-character. */
export function buildSupersededComment(survivorNumber: number, woId: string): string {
  return (
    `Superseded by #${survivorNumber} (lane PR dedupe for ${woId}). ` +
    'Closed automatically by the PR repair owner; branch kept. ' +
    `Runbook: ${PR_REPAIR_RUNBOOK_PATH}`
  );
}

function parseMs(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

/** Newest-first by createdAt (ties broken by higher PR number, deterministic). */
function newestFirst(a: LanePr, b: LanePr): number {
  const delta = parseMs(b.createdAt) - parseMs(a.createdAt);
  if (delta !== 0) return delta;
  return b.prNumber - a.prNumber;
}

function isApproved(pr: LanePr): boolean {
  return (pr.reviewDecision ?? '').toUpperCase() === 'APPROVED';
}

export interface DedupePlan {
  /** The survivor PR, or null when fewer than one OPEN lane PR exists. */
  survivor: LanePr | null;
  /** OPEN, non-survivor, NOT APPROVED -- safe to close. */
  toClose: LanePr[];
  /** OPEN, non-survivor, APPROVED -- never closed; needs a human. */
  approvedNonSurvivors: LanePr[];
}

/**
 * Decide the survivor and the closable set from a WO's lane PRs. Only OPEN lane
 * PRs are considered; survivor = newest OPEN APPROVED, else newest OPEN. Every
 * other OPEN PR is closable unless it is APPROVED (then it needs a human).
 */
export function planDedupe(lanePrs: readonly LanePr[]): DedupePlan {
  const open = lanePrs
    .filter(pr => pr.state === 'OPEN')
    .slice()
    .sort(newestFirst);
  if (open.length === 0) return { survivor: null, toClose: [], approvedNonSurvivors: [] };
  const approved = open.filter(isApproved);
  const survivor = approved.length > 0 ? approved[0] : open[0];
  const toClose: LanePr[] = [];
  const approvedNonSurvivors: LanePr[] = [];
  for (const pr of open) {
    if (pr.prNumber === survivor.prNumber) continue;
    if (isApproved(pr)) approvedNonSurvivors.push(pr);
    else toClose.push(pr);
  }
  return { survivor, toClose, approvedNonSurvivors };
}

function parseLaneRepairCandidate(body: string): LaneRepairCandidate | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.kind !== 'overseer_remediation_candidate') return null;
  const classes = Array.isArray(value.findingClasses) ? value.findingClasses : [];
  if (!classes.includes('lane_repair')) return null;
  if (
    typeof value.owner !== 'string' ||
    typeof value.repo !== 'string' ||
    typeof value.prNumber !== 'number' ||
    typeof value.headSha !== 'string' ||
    typeof value.woId !== 'string' ||
    typeof value.headRef !== 'string'
  ) {
    return null;
  }
  return {
    owner: value.owner,
    repo: value.repo,
    prNumber: value.prNumber,
    headSha: value.headSha,
    woId: value.woId,
    headRef: value.headRef,
    verdictBody: typeof value.verdictBody === 'string' ? value.verdictBody : '',
    workflowName: null,
  };
}

function parseExhaustedRow(body: string): ExhaustedRow | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (value.kind !== 'overseer_remediation_exhausted') return null;
  if (
    typeof value.owner !== 'string' ||
    typeof value.repo !== 'string' ||
    typeof value.prNumber !== 'number' ||
    typeof value.woId !== 'string' ||
    typeof value.reason !== 'string'
  ) {
    return null;
  }
  return {
    owner: value.owner,
    repo: value.repo,
    prNumber: value.prNumber,
    woId: value.woId,
    reason: value.reason,
  };
}

function slug(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

/**
 * Run one tick of the PR repair owner. Returns the digest lines to ride along on
 * the daily digest and a finalizer that addresses the exhausted rows once that
 * digest is sent. Never throws for an expected per-item failure; it addresses
 * the row with a refusal note and moves on.
 */
export async function runPrRepairOwner(deps: PrRepairOwnerDeps): Promise<PrRepairOwnerResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => undefined);
  const withinHours = deps.dedupeWindowHours ?? PR_REPAIR_DEDUPE_WINDOW_HOURS_DEFAULT;
  const digestItems: string[] = [];
  let closedPrs = 0;

  // (1) DEDUPE SWEEP -----------------------------------------------------------
  const dupeWos = (
    await deps.listWosWithMultipleLanePrs({ fetchPr: deps.fetchPr, withinHours, now })
  ).slice(0, MAX_DEDUPE_WOS_PER_TICK);
  for (const entry of dupeWos) {
    const plan = planDedupe(entry.prs);
    if (!plan.survivor) continue;
    for (const victim of plan.toClose) {
      try {
        await deps.closePr({
          owner: victim.owner,
          repo: victim.repo,
          prNumber: victim.prNumber,
          comment: buildSupersededComment(plan.survivor.prNumber, entry.woId),
        });
        closedPrs += 1;
        log('pr_repair.dedupe_closed', {
          woId: entry.woId,
          closed: victim.prNumber,
          survivor: plan.survivor.prNumber,
        });
      } catch (error) {
        log('pr_repair.dedupe_close_failed', {
          woId: entry.woId,
          prNumber: victim.prNumber,
          error: (error as Error).message,
        });
      }
    }
    for (const approved of plan.approvedNonSurvivors) {
      digestItems.push(
        `${slug(approved.owner, approved.repo, approved.prNumber)} ${entry.woId} ` +
          `dedupe_needs_human (survivor #${plan.survivor.prNumber})`
      );
    }
  }

  // Read queued Taskmaster rows once; split into candidates and exhausted.
  const queued = await deps.listQueuedTaskmasterMessages();
  const candidates: { id: string; candidate: LaneRepairCandidate }[] = [];
  const exhausted: { id: string; row: ExhaustedRow }[] = [];
  for (const message of queued) {
    const candidate = parseLaneRepairCandidate(message.body);
    if (candidate) {
      candidates.push({ id: message.id, candidate });
      continue;
    }
    const row = parseExhaustedRow(message.body);
    if (row) exhausted.push({ id: message.id, row });
  }

  // (2) REPAIR -- at most MAX_REPAIR_FIRES_PER_TICK fires this tick -------------
  let repairsFired = 0;
  for (const { id, candidate } of candidates) {
    if (repairsFired >= MAX_REPAIR_FIRES_PER_TICK) break;

    // Re-prove the LANE PR RULE: the PR must still be lane-created for this WO.
    const lanePrs = await deps.listLanePrsForWo(candidate.woId, {
      fetchPr: deps.fetchPr,
      now,
    });
    const target = lanePrs.find(pr => pr.prNumber === candidate.prNumber);
    if (!target) {
      await addressRefusal(deps, id, 'refused:not_lane_created', log);
      continue;
    }

    // Collapse-first: a non-survivor is never repaired.
    const plan = planDedupe(lanePrs);
    if (plan.survivor && plan.survivor.prNumber !== candidate.prNumber) {
      await addressRefusal(deps, id, `refused:superseded_by_#${plan.survivor.prNumber}`, log);
      continue;
    }

    // The reviewed head must still be the live head of an OPEN PR.
    if (target.state !== 'OPEN' || target.headSha !== candidate.headSha) {
      await addressRefusal(deps, id, 'refused:stale_head', log);
      continue;
    }

    // Never race a run that is still building this WO; leave the row queued.
    if (await deps.hasRunningRunForWo(candidate.woId)) {
      log('pr_repair.repair_skipped_running', {
        woId: candidate.woId,
        prNumber: candidate.prNumber,
      });
      continue;
    }

    const entryOverride =
      (deps.resolveEntryTier ?? ((): string | undefined => undefined))(target.workflowName) ??
      'claude';

    // Acknowledge BEFORE firing, address with the cascade id on admission.
    await deps.acknowledgeRow(id);
    let admitted: ((cascadeId: string) => void) | null = null;
    let rejected: ((error: unknown) => void) | null = null;
    const admission = new Promise<string>((resolve, reject) => {
      admitted = resolve;
      rejected = reject;
    });
    const firePromise = deps.fireRepairCascade({
      woId: candidate.woId,
      project: target.repo,
      entryOverride,
      initialPriorContext: candidate.verdictBody,
      repair: { prNumber: candidate.prNumber, headRef: target.headRef, attemptId: id },
      dispatchId: id,
      ...(deps.token ? { token: deps.token } : {}),
      onAdmission: record => admitted?.(record.cascadeId),
    });
    void firePromise.then(record => admitted?.(record.cascadeId)).catch(error => rejected?.(error));
    let cascadeId: string;
    try {
      cascadeId = await admission;
    } catch (error) {
      log('pr_repair.repair_fire_failed', {
        woId: candidate.woId,
        prNumber: candidate.prNumber,
        error: (error as Error).message,
      });
      await addressRefusal(deps, id, 'refused:fire_failed', log);
      continue;
    }
    await deps.addressRow(id, `fired:${cascadeId}`);
    repairsFired += 1;
    log('pr_repair.repair_fired', {
      woId: candidate.woId,
      prNumber: candidate.prNumber,
      cascadeId,
    });
  }

  // (3) EXHAUSTED -- one digest line each; addressed only after the digest sends.
  const exhaustedRowIds: string[] = [];
  for (const { id, row } of exhausted) {
    digestItems.push(`${slug(row.owner, row.repo, row.prNumber)} ${row.woId} ${row.reason}`);
    exhaustedRowIds.push(id);
  }

  const commitExhausted = async (): Promise<void> => {
    for (const id of exhaustedRowIds) {
      try {
        await deps.acknowledgeRow(id);
        await deps.addressRow(id, 'digested');
      } catch (error) {
        log('pr_repair.exhausted_address_failed', { id, error: (error as Error).message });
      }
    }
  };

  return { digestItems, closedPrs, repairsFired, exhaustedRowIds, commitExhausted };
}

async function addressRefusal(
  deps: PrRepairOwnerDeps,
  id: string,
  note: string,
  log: (event: string, fields: Record<string, unknown>) => void
): Promise<void> {
  try {
    await deps.acknowledgeRow(id);
    await deps.addressRow(id, note);
    log('pr_repair.candidate_refused', { id, note });
  } catch (error) {
    log('pr_repair.candidate_refuse_failed', { id, note, error: (error as Error).message });
  }
}
