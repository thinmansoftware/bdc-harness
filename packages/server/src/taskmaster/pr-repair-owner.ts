/**
 * pr-repair-owner.ts -- route rejected PRs to their existing repair owners,
 * collapse duplicate lane PRs to a single survivor, and surface
 * exhausted/judgment cases as one Duty Officer digest line.
 *
 * WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01.
 *
 * John's 2026-08-28 ruling: the Overseer JUDGES a rejected PR and hands it back;
 * Taskmaster routes it to its owner under R6-R10; it never fires a repair
 * cascade. This module plans three bounded steps, whose effects are admitted
 * by the existing tick pause, budget, epoch and journal controls:
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
 *      a run for the WO is still running, then route the repair to its existing
 *      owner or admit an unresolved-owner digest line.
 *
 *  (3) EXHAUSTED. Turn each queued overseer_remediation_exhausted row into one
 *      digest line; the caller addresses those rows AFTER the digest carrying
 *      them is persisted (commitDigestLines), so a failed digest never loses the line.
 *
 * Every external effect is an INJECTED seam, so the owner's whole decision tree
 * runs in tests with no network and no real GitHub writes.
 */
import type { DispatchMessage } from '@archon/core/db/dispatch';
import { textClaimsWoId } from '@archon/smart-cauldron/already-satisfied';
import { TM_ALLOWED_RECIPIENTS } from './guard';
import type { ActionProposal } from './rules';
import type {
  LanePr,
  LanePrFetcher,
  ListWosWithMultipleLanePrsResult,
} from '@archon/core/db/lane-pr-registry';

/** Default dedupe lookback window (hours). Overridable via env. */
export const PR_REPAIR_DEDUPE_WINDOW_HOURS_DEFAULT = 168;
export function resolvePrRepairDedupeWindowHours(raw: string | undefined): number {
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : PR_REPAIR_DEDUPE_WINDOW_HOURS_DEFAULT;
}
/** At most one repair cascade is fired per tick -- the bounded-fire contract. */
export const MAX_REPAIR_FIRES_PER_TICK = 1;
/** At most this many duplicate-PR work orders are swept per tick. */
export const MAX_DEDUPE_WOS_PER_TICK = 5;

/** The runbook every automated close comment points a human at. */
export const PR_REPAIR_RUNBOOK_PATH = 'docs/operations/pr-repair-owner.md';

/** A queued dispatch row as the owner needs to read it. */
export type PrRepairQueuedMessage = Pick<
  DispatchMessage,
  | 'id'
  | 'body'
  | 'sender'
  | 'sender_principal_id'
  | 'recipient'
  | 'resolved_recipient'
  | 'status'
  | 'addressed_at'
  | 'addressed_by'
  | 'route_disposition'
  | 'acknowledged_at'
  | 'acknowledged_by'
>;

function authenticatedRepairMessage(message: PrRepairQueuedMessage): boolean {
  return (
    message.sender === 'overseer' &&
    message.sender_principal_id === 'system:overseer' &&
    message.recipient === 'taskmaster' &&
    (message.resolved_recipient === null || message.resolved_recipient === 'taskmaster') &&
    message.status === 'queued' &&
    message.addressed_at === null &&
    message.addressed_by === null &&
    message.route_disposition === null
  );
}

function repairAcknowledgmentEligible(message: PrRepairQueuedMessage, now: number): boolean {
  if (message.acknowledged_by === null && message.acknowledged_at === null) return true;
  const acknowledgedAt = message.acknowledged_at ? Date.parse(message.acknowledged_at) : NaN;
  const age = now - acknowledgedAt;
  return (
    message.acknowledged_by === 'taskmaster' && Number.isFinite(age) && age >= 0 && age <= 3600000
  );
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
  woId: string | null;
  reason: string;
  prUrl: string;
  headSha: string;
  headRef: string;
  owningLane: string | null;
  buildLine: 'cauldron' | 'outside';
  lastVerdictSummary: string;
}

export interface RepairOwnerIssue {
  title: string;
  state: string;
  labels: string[];
  ownerLogin: string | null;
}

export interface PrRepairEffect {
  proposal: ActionProposal;
  kind: 'dedupe_close' | 'owner_nudge' | 'digest_item';
  sourceRowId?: string;
  digestLine?: string;
  addressNote?: 'digested' | 'owner_unresolved';
  apply: () => Promise<{ body?: string; applied?: false } | undefined>;
}

export interface PrRepairOwnerDeps {
  /** Clock seam (ms). Defaults to Date.now. */
  now?: () => number;
  /** Dedupe lookback window in hours. Defaults to PR_REPAIR_DEDUPE_WINDOW_HOURS_DEFAULT. */
  dedupeWindowHours?: number;
  /** GitHub PR fetcher (injected; no implicit network). */
  fetchPr: LanePrFetcher;
  /** WOs with 2+ lane-created PRs within the window, plus unresolved lookups. */
  listWosWithMultipleLanePrs: (opts: {
    fetchPr: LanePrFetcher;
    withinHours?: number;
    now?: () => number;
  }) => Promise<ListWosWithMultipleLanePrsResult>;
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
  /** Open bdc-xo work-order issues used only to resolve the existing owner. */
  listOwnerIssues?: () => Promise<RepairOwnerIssue[]>;
  /** Existing Taskmaster login-to-seat mapping. */
  resolveRecipient?: (login: string | null | undefined) => string;
  /** Persist one validated Taskmaster nudge. */
  createOwnerNudge?: (input: {
    recipient: string;
    body: string;
    subjectKey: string;
    idempotencyKey: string;
  }) => Promise<{ body?: string }>;
  /** Production plans effects for the loop; legacy unit harnesses may apply closes inline. */
  planEffects?: boolean;
  /** Compatibility/read seam; the loop itself owns effect admission. */
  canApplyEffect?: () => Promise<boolean>;
  /** Structured log seam (optional). */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface PrRepairOwnerResult {
  /** One line per exhausted/judgment case, for the daily digest. */
  digestItems: string[];
  /** Number of non-survivor PRs closed by the dedupe sweep. */
  closedPrs: number;
  /** Effects awaiting the loop's common admission/journal path. */
  effects: PrRepairEffect[];
  /** Backward-compatible metric; Taskmaster no longer fires repairs. */
  repairsFired: 0;
  /** Queued exhausted row ids awaiting their digest line to be sent. */
  exhaustedRowIds: string[];
  /**
   * Address the exhausted rows that produced this tick's digest items. The
   * caller invokes this ONLY after the digest is sent, so a failed digest never
   * drops the line (the row stays queued for the next tick). Idempotent.
   */
  commitDigestLines: (
    persistedBody: string,
    admittedItemKeys: ReadonlySet<string>
  ) => Promise<void>;
}

const FORBIDDEN_REPAIR_RECIPIENTS = new Set(['xo', 'operator', 'duty-officer']);

export async function resolveRepairOwner(
  woId: string | null,
  deps: Pick<PrRepairOwnerDeps, 'listOwnerIssues' | 'resolveRecipient'>
): Promise<string | null> {
  if (!woId || !deps.listOwnerIssues) return null;
  const matches = (await deps.listOwnerIssues()).filter(
    value => value.state.toLowerCase() === 'open' && textClaimsWoId(value.title, woId)
  );
  if (matches.length !== 1) return null;
  const issue = matches[0];
  for (const label of issue.labels) {
    const match = /^owner:([^\s]+)$/i.exec(label.trim());
    if (!match) continue;
    const seat = match[1].toLowerCase();
    if (
      (TM_ALLOWED_RECIPIENTS as readonly string[]).includes(seat) &&
      !FORBIDDEN_REPAIR_RECIPIENTS.has(seat)
    )
      return seat;
  }
  const mapped = deps.resolveRecipient?.(issue.ownerLogin) ?? null;
  return mapped &&
    (TM_ALLOWED_RECIPIENTS as readonly string[]).includes(mapped) &&
    !FORBIDDEN_REPAIR_RECIPIENTS.has(mapped)
    ? mapped
    : null;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.kind !== 'overseer_remediation_exhausted') return null;
  if (
    typeof value.owner !== 'string' ||
    typeof value.repo !== 'string' ||
    typeof value.prNumber !== 'number' ||
    typeof value.reason !== 'string'
  ) {
    return null;
  }
  return {
    owner: value.owner,
    repo: value.repo,
    prNumber: value.prNumber,
    woId: typeof value.woId === 'string' ? value.woId : null,
    reason: value.reason,
    prUrl:
      typeof value.prUrl === 'string'
        ? value.prUrl
        : `https://github.com/${value.owner}/${value.repo}/pull/${value.prNumber}`,
    headSha: typeof value.headSha === 'string' ? value.headSha : '',
    headRef: typeof value.headRef === 'string' ? value.headRef : '',
    owningLane: typeof value.owningLane === 'string' ? value.owningLane : null,
    buildLine: value.buildLine === 'outside' ? 'outside' : 'cauldron',
    lastVerdictSummary:
      typeof value.lastVerdictSummary === 'string' ? value.lastVerdictSummary.slice(0, 600) : '',
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
  const effects: PrRepairEffect[] = [];
  const exhaustedRowIds: string[] = [];

  const addDigestItem = (
    line: string,
    key: string,
    sourceRowId?: string,
    addressNote: 'digested' | 'owner_unresolved' = 'digested'
  ): void => {
    const idempotencyKey = `tm:repair-digest-item:${key}`;
    if (effects.some(effect => effect.proposal.idempotencyKey === idempotencyKey)) return;
    digestItems.push(line);
    effects.push({
      kind: 'digest_item',
      sourceRowId,
      digestLine: line,
      addressNote,
      proposal: {
        type: 'pr_repair',
        threadRef: `pr-repair:${key}`,
        recipient: 'duty-officer',
        body: line,
        idempotencyKey,
        actsImmediately: true,
      },
      apply: async () => undefined,
    });
  };

  const closePlan = async (woId: string, plan: DedupePlan): Promise<void> => {
    const plannedSurvivor = plan.survivor;
    if (!plannedSurvivor) return;
    for (const victim of plan.toClose) {
      try {
        const survivor = await deps.fetchPr(
          plannedSurvivor.owner,
          plannedSurvivor.repo,
          plannedSurvivor.prNumber
        );
        const current = await deps.fetchPr(victim.owner, victim.repo, victim.prNumber);
        const unchanged = (live: typeof current, prior: LanePr): boolean =>
          live?.number === prior.prNumber &&
          live.state === 'OPEN' &&
          live.headSha === prior.headSha &&
          live.headRefName === prior.headRef &&
          live.reviewDecision === prior.reviewDecision;
        if (
          !unchanged(survivor, plannedSurvivor) ||
          !unchanged(current, victim) ||
          (current?.reviewDecision ?? '').toUpperCase() === 'APPROVED'
        )
          continue;
        const comment = buildSupersededComment(plannedSurvivor.prNumber, woId);
        const effect: PrRepairEffect = {
          kind: 'dedupe_close',
          proposal: {
            type: 'pr_repair',
            threadRef: `pr-repair:${victim.owner}/${victim.repo}#${victim.prNumber}`,
            recipient: 'duty-officer',
            body: `Close duplicate lane PR ${victim.owner}/${victim.repo}#${victim.prNumber}. ${comment}`,
            idempotencyKey: `tm:pr-dedupe:${woId}:${victim.owner.toLowerCase()}/${victim.repo.toLowerCase()}#${victim.prNumber}:survivor-${plannedSurvivor.prNumber}`,
            actsImmediately: true,
          },
          apply: async () => {
            // Planning is not execution authority: discovery and earlier effects
            // may have allowed either PR's eligibility to change in the meantime.
            const liveSurvivor = await deps.fetchPr(
              plannedSurvivor.owner,
              plannedSurvivor.repo,
              plannedSurvivor.prNumber
            );
            const liveVictim = await deps.fetchPr(victim.owner, victim.repo, victim.prNumber);
            if (
              !unchanged(liveSurvivor, plannedSurvivor) ||
              !unchanged(liveVictim, victim) ||
              (liveVictim?.reviewDecision ?? '').toUpperCase() === 'APPROVED'
            ) {
              return { applied: false };
            }
            await deps.closePr({
              owner: victim.owner,
              repo: victim.repo,
              prNumber: victim.prNumber,
              comment,
            });
            closedPrs += 1;
            return undefined;
          },
        };
        effects.push(effect);
        if (!deps.planEffects) await effect.apply();
      } catch (error) {
        log('pr_repair.dedupe_close_failed', {
          woId: woId,
          prNumber: victim.prNumber,
          error: (error as Error).message,
        });
      }
    }
  };

  // (1) DEDUPE SWEEP -----------------------------------------------------------
  const hasClosableDuplicates = (entry: { prs: LanePr[] }): boolean => {
    const groups = new Map<string, LanePr[]>();
    for (const pr of entry.prs) {
      const key = `${pr.owner}/${pr.repo}`.toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), pr]);
    }
    return [...groups.values()].some(prs => planDedupe(prs).toClose.length > 0);
  };
  const dedupe = await deps.listWosWithMultipleLanePrs({
    fetchPr: deps.fetchPr,
    withinHours,
    now,
  });
  for (const unresolved of dedupe.unresolved) {
    log('pr_repair.dedupe_lookup_failed', {
      woId: unresolved.woId,
      owner: unresolved.owner,
      repo: unresolved.repo,
      prNumber: unresolved.prNumber,
      error: unresolved.error,
    });
  }
  const dupeWos = dedupe.groups
    .filter(entry => {
      const openByRepository = new Map<string, number>();
      for (const pr of entry.prs) {
        if (pr.state !== 'OPEN') continue;
        const key = `${pr.owner}/${pr.repo}`.toLowerCase();
        const count = (openByRepository.get(key) ?? 0) + 1;
        if (count >= 2) return true;
        openByRepository.set(key, count);
      }
      return false;
    })
    // Approved-only groups need a human; they cannot consume every bounded
    // slot while an actionable duplicate sits later in the same result set.
    .sort((a, b) => Number(hasClosableDuplicates(b)) - Number(hasClosableDuplicates(a)))
    .slice(0, MAX_DEDUPE_WOS_PER_TICK);
  for (const entry of dupeWos) {
    const repositories = new Map<string, LanePr[]>();
    for (const pr of entry.prs) {
      const key = `${pr.owner}/${pr.repo}`.toLowerCase();
      repositories.set(key, [...(repositories.get(key) ?? []), pr]);
    }
    for (const prs of repositories.values()) {
      const plan = planDedupe(prs);
      if (!plan.survivor) continue;
      await closePlan(entry.woId, plan);
      for (const approved of plan.approvedNonSurvivors) {
        addDigestItem(
          `${slug(approved.owner, approved.repo, approved.prNumber)} ${entry.woId} ` +
            `dedupe_needs_human (survivor #${plan.survivor.prNumber})`,
          `dedupe:${entry.woId}:${slug(approved.owner, approved.repo, approved.prNumber)}:survivor-${plan.survivor.prNumber}`
        );
      }
    }
  }

  // Read queued Taskmaster rows once; split into candidates and exhausted.
  const queued = await deps.listQueuedTaskmasterMessages();
  const candidates: { id: string; candidate: LaneRepairCandidate }[] = [];
  const exhausted: { id: string; row: ExhaustedRow }[] = [];
  for (const message of queued) {
    // Metadata is authority. Reject before acknowledgment, GitHub reads or the
    // bounded admission allowance; a matching JSON body is not a trusted sender.
    if (!authenticatedRepairMessage(message)) continue;
    const candidate = parseLaneRepairCandidate(message.body);
    if (candidate) {
      if (!repairAcknowledgmentEligible(message, now())) {
        addDigestItem(
          `${slug(candidate.owner, candidate.repo, candidate.prNumber)} ${candidate.woId} repair_acknowledgment_invalid`,
          `acknowledgment-invalid:${message.id}`
        );
        continue;
      }
      candidates.push({ id: message.id, candidate });
      continue;
    }
    const row = parseExhaustedRow(message.body);
    if (row) exhausted.push({ id: message.id, row });
  }

  // (2) REPAIR -- validate at most one candidate and route it to its owner.
  let admissionAttempts = 0;
  for (const { id, candidate } of candidates) {
    if (admissionAttempts >= MAX_REPAIR_FIRES_PER_TICK) break;

    // Re-prove the LANE PR RULE: the PR must still be lane-created for this WO.
    // A lookup failure leaves the row queued. It is not a not-lane refusal.
    let lanePrs: LanePr[];
    try {
      lanePrs = await deps.listLanePrsForWo(candidate.woId, {
        fetchPr: deps.fetchPr,
        now,
      });
    } catch (error) {
      log('pr_repair.lane_lookup_failed', {
        woId: candidate.woId,
        owner: candidate.owner,
        repo: candidate.repo,
        prNumber: candidate.prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    // Match the full repository slug (case-insensitive) AND the PR number:
    // identical PR numbers for the same WO can exist across repositories, so
    // matching prNumber alone could select and repair the wrong PR.
    const candidateSlug = slug(candidate.owner, candidate.repo, candidate.prNumber).toLowerCase();
    const target = lanePrs.find(
      pr => slug(pr.owner, pr.repo, pr.prNumber).toLowerCase() === candidateSlug
    );
    if (!target) {
      await addressRefusal(deps, id, 'refused:not_lane_created', log);
      continue;
    }
    // freezeWorkOrderSource reads this immutable dispatch body's branch.
    // It must equal the validated live branch, even when the SHA is unchanged.
    if (target.headRef !== candidate.headRef) {
      await addressRefusal(deps, id, 'refused:stale_branch', log);
      continue;
    }

    // Collapse-first: a non-survivor is never repaired. Scope the dedupe to the
    // candidate's OWN repository -- a WO's lane PRs can span repositories, and a
    // same-number PR in a different repo must not be able to supersede (or be
    // superseded by) this one. Compare the survivor by full repo slug, not
    // prNumber alone.
    const candidateRepoSlug = `${candidate.owner}/${candidate.repo}`.toLowerCase();
    const sameRepoLanePrs = lanePrs.filter(
      pr => `${pr.owner}/${pr.repo}`.toLowerCase() === candidateRepoSlug
    );
    const plan = planDedupe(sameRepoLanePrs);
    if (
      plan.survivor &&
      slug(plan.survivor.owner, plan.survivor.repo, plan.survivor.prNumber).toLowerCase() !==
        candidateSlug
    ) {
      await addressRefusal(deps, id, `refused:superseded_by_#${plan.survivor.prNumber}`, log);
      continue;
    }

    // The reviewed head must still be the live head of an OPEN PR.
    if (target.state !== 'OPEN' || target.headSha !== candidate.headSha) {
      await addressRefusal(deps, id, 'refused:stale_head', log);
      continue;
    }
    if (isApproved(target)) {
      await addressRefusal(deps, id, 'refused:already_approved', log);
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

    // A candidate outside the bounded/windowed sweep must still satisfy the
    // same collapse-first rule. Re-read after closes: failed or unsafe closes
    // never authorize a repair over another OPEN claimant.
    await closePlan(candidate.woId, plan);
    let afterDedupe: LanePr[];
    try {
      afterDedupe = await deps.listLanePrsForWo(candidate.woId, { fetchPr: deps.fetchPr, now });
    } catch (error) {
      log('pr_repair.lane_lookup_failed', {
        woId: candidate.woId,
        owner: candidate.owner,
        repo: candidate.repo,
        prNumber: candidate.prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const otherOpen = afterDedupe.some(
      pr =>
        pr.state === 'OPEN' &&
        `${pr.owner}/${pr.repo}`.toLowerCase() === candidateRepoSlug &&
        pr.prNumber !== candidate.prNumber
    );
    if (otherOpen) {
      const line = `${candidateSlug} ${candidate.woId} repair_waiting_for_dedupe`;
      addDigestItem(line, `waiting-for-dedupe:${id}`);
      continue;
    }

    const current = await deps.fetchPr(candidate.owner, candidate.repo, candidate.prNumber);
    if (
      current?.state !== 'OPEN' ||
      current.headSha !== candidate.headSha ||
      current.headRefName !== target.headRef ||
      (current.reviewDecision ?? '').toUpperCase() === 'APPROVED'
    ) {
      await addressRefusal(deps, id, 'refused:review_eligibility_changed', log);
      continue;
    }
    admissionAttempts += 1;
    await planOwnerRoute(id, {
      owner: candidate.owner,
      repo: candidate.repo,
      prNumber: candidate.prNumber,
      woId: candidate.woId,
      reason: 'cauldron_repair_pending',
      buildLine: 'cauldron',
      prUrl: `https://github.com/${candidate.owner}/${candidate.repo}/pull/${candidate.prNumber}`,
      lastVerdictSummary: candidate.verdictBody.slice(0, 600),
    });
  }

  // (3) EXHAUSTED -- one digest line each; addressed only after the digest sends.
  for (const { id, row } of exhausted) {
    await planOwnerRoute(id, row);
  }

  async function planOwnerRoute(
    id: string,
    row: Pick<
      ExhaustedRow,
      | 'owner'
      | 'repo'
      | 'prNumber'
      | 'woId'
      | 'reason'
      | 'buildLine'
      | 'prUrl'
      | 'lastVerdictSummary'
    >
  ): Promise<void> {
    const recipient = await resolveRepairOwner(row.woId, deps);
    if (recipient && deps.createOwnerNudge) {
      const createOwnerNudge = deps.createOwnerNudge;
      const body =
        `Repair ${row.prUrl} for ${row.woId}: reason=${row.reason}; buildLine=${row.buildLine}. ${row.lastVerdictSummary}`.trim();
      effects.push({
        kind: 'owner_nudge',
        sourceRowId: id,
        proposal: {
          type: 'pr_repair',
          threadRef: `pr-repair:${id}`,
          recipient,
          body,
          idempotencyKey: `tm:repair-to-owner:${id}`,
          actsImmediately: true,
        },
        apply: async () => {
          const persisted = await createOwnerNudge({
            recipient,
            body,
            subjectKey: `repair:${row.owner}/${row.repo}#${row.prNumber}`,
            idempotencyKey: `tm:repair-to-owner:${id}`,
          });
          await deps.acknowledgeRow(id);
          await deps.addressRow(id, `routed_to_owner:${recipient}`);
          return persisted;
        },
      });
      return;
    }
    const reason = row.woId ? row.reason : 'no_wo';
    const line = `${slug(row.owner, row.repo, row.prNumber)} ${row.woId ?? 'no-wo'} repair_owner_unresolved:${reason}`;
    exhaustedRowIds.push(id);
    addDigestItem(
      line,
      id,
      id,
      row.reason === 'cauldron_repair_pending' ? 'owner_unresolved' : 'digested'
    );
  }

  const commitDigestLines = async (
    persistedBody: string,
    admittedItemKeys: ReadonlySet<string>
  ): Promise<void> => {
    for (const effect of effects.filter(value => value.kind === 'digest_item')) {
      if (
        !admittedItemKeys.has(effect.proposal.idempotencyKey) ||
        !effect.sourceRowId ||
        !effect.digestLine ||
        !persistedBody.includes(effect.digestLine)
      )
        continue;
      try {
        await deps.acknowledgeRow(effect.sourceRowId);
        await deps.addressRow(effect.sourceRowId, effect.addressNote ?? 'digested');
      } catch (error) {
        log('pr_repair.exhausted_address_failed', {
          id: effect.sourceRowId,
          error: (error as Error).message,
        });
      }
    }
  };

  return {
    digestItems,
    get closedPrs(): number {
      return closedPrs;
    },
    effects,
    repairsFired: 0,
    exhaustedRowIds,
    commitDigestLines,
  };
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
