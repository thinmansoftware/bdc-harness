/**
 * Judge-first record pipeline (Motion M-99): claim -> judge -> verdict row ->
 * tier ruling -> Tier 0 action -> receipt. Replaces the classifier-gated v1
 * handleRecord branches when OVERSEER_JUDGE_FIRST is enabled.
 *
 * Invariants (binding terms):
 *  - EVERY terminal run leaves a verdict row, including healthy/ignore shapes.
 *  - The permit layer is NOT consulted anywhere on this path; authority is the
 *    M-15 tier map, and it gates execution only, never consultation.
 *  - Judge health failures finalize as alarm states and escalate loudly when
 *    the retry budget is exhausted -- they never become semantic verdicts.
 *  - Replay: a lost claim means another pass already owns this evidence; the
 *    pipeline exits without a model call or a second action.
 */

import { createLogger } from '@archon/paths';
import {
  buildEvidenceEnvelope,
  envelopeDigest,
  judgeTerminalRun,
  type JudgeFirstOptions,
  type JudgeOutcome,
} from './judge-first';
import { ruleOnAction, type TierRuling } from './tier-map';
import { runEscalation } from './escalate';
import { isPrMergeReady } from './judge-pr';
import type {
  GitHubClientDeps,
  OverseerActionsDeps,
  OverseerRunStoreDeps,
  OverseerVerdictStoreDeps,
  OverseerWorkflowEvent,
  WatchedRunRecord,
} from './types.ts';
import type { MergeReadyCoordinator } from './service';
import type { ErrorClass } from './classify.ts';

const log = createLogger('overseer/judge-first-pipeline');

const DEFAULT_MAX_RETRIES = 3;

export interface JudgeFirstPipelineOptions {
  dryRun: boolean;
  actor: string;
  mergeCoordinator?: MergeReadyCoordinator;
  verdictStore: OverseerVerdictStoreDeps;
  judge?: (
    envelope: ReturnType<typeof buildEvidenceEnvelope>,
    options?: JudgeFirstOptions
  ) => Promise<JudgeOutcome>;
  judgeOptions?: JudgeFirstOptions;
  maxRetries?: number;
  /** Injectable escalation executor; defaults to runEscalation (operator card rail). */
  escalate?: typeof runEscalation;
}

function actionClass(record: WatchedRunRecord): string {
  return record.errorClass ?? 'none';
}

function newestEvent(events: OverseerWorkflowEvent[]): OverseerWorkflowEvent | undefined {
  return [...events].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')).at(-1);
}

async function escalateWithEvidence(
  record: WatchedRunRecord,
  deps: OverseerActionsDeps,
  events: OverseerWorkflowEvent[],
  input: { verdictId: string; reason: string; blocker: string },
  escalate: typeof runEscalation = runEscalation
): Promise<void> {
  const source = newestEvent(events);
  if (!source?.id || !source.created_at) {
    // Fail loud: the alarm is recorded even when no event identity exists to
    // hang an operator card on.
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'escalate_with_evidence',
      result: `escalation_source_event_missing:verdict:${input.verdictId}`,
    });
    return;
  }
  const errorClass: ErrorClass =
    record.errorClass === 'tail_node_false_fail' ? 'unknown' : (record.errorClass ?? 'unknown');
  try {
    const card = await escalate(
      record.runId,
      { decision: 'escalate', reason: input.blocker },
      {
        errorClass,
        woId: record.woId,
        repository: record.owner && record.repo ? `${record.owner}/${record.repo}` : undefined,
        branch: record.headBranch ?? null,
        prUrl: record.prEvidence?.htmlUrl ?? null,
        prNumber: record.prEvidence?.pr?.number ?? null,
        checks: record.prEvidence?.checks ?? {},
        mergeability:
          record.prEvidence?.mergeable === null
            ? 'unknown'
            : String(record.prEvidence?.mergeable ?? 'unknown'),
        verdictId: input.verdictId,
      },
      {
        sourceEventId: source.id,
        eventType: source.event_type,
        stepName: source.step_name ?? 'unknown',
        eventCreatedAt: source.created_at,
      }
    );
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'escalate_with_evidence',
      result: `${input.reason}:operator_card:${card.card_id}:verdict:${input.verdictId}`,
    });
  } catch (error) {
    log.error(
      { err: error as Error, runId: record.runId, verdictId: input.verdictId },
      'overseer.judge_first.escalation_failed'
    );
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'escalate_with_evidence',
      result: `escalation_failed:${(error as Error).message.slice(0, 120)}:verdict:${input.verdictId}`,
    });
  }
}

async function commentFindings(
  record: WatchedRunRecord,
  deps: OverseerActionsDeps & GitHubClientDeps,
  input: { verdictId: string; verdict: string; reason: string; dryRun: boolean }
): Promise<void> {
  const pr = record.prEvidence?.pr;
  if (!pr) {
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'comment_findings',
      result: `comment_skipped_no_pr:verdict:${input.verdictId}`,
    });
    return;
  }
  if (input.dryRun) {
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'comment_findings',
      result: `dry_run:verdict:${input.verdictId}`,
    });
    return;
  }
  if (!deps.commentOnPullRequest) {
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'comment_findings',
      result: `comment_channel_unavailable:verdict:${input.verdictId}`,
    });
    return;
  }
  const body = [
    `Overseer verdict (judge-first, verdict ${input.verdictId}):`,
    '',
    `- run: ${record.runId} (${record.status})`,
    `- WO: ${record.woId}`,
    `- verdict: ${input.verdict}`,
    `- reason: ${input.reason}`,
    '',
    'Autonomous Tier 0 finding -- no merge or mutation performed.',
  ].join('\n');
  try {
    const result = await deps.commentOnPullRequest({ ...pr, body });
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'comment_findings',
      result: result.commented
        ? `commented:${result.url ?? 'ok'}:verdict:${input.verdictId}`
        : `comment_failed:verdict:${input.verdictId}`,
    });
  } catch (error) {
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'comment_findings',
      result: `comment_failed:${(error as Error).message.slice(0, 120)}:verdict:${input.verdictId}`,
    });
  }
}

export async function handleRecordJudgeFirst(
  record: WatchedRunRecord,
  deps: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps,
  options: JudgeFirstPipelineOptions
): Promise<void> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headSha = record.prEvidence?.headSha ?? '';

  const claim = await options.verdictStore.claimVerdict({
    runId: record.runId,
    woId: record.woId,
    headSha,
    hintAction: record.action,
    hintErrorClass: record.errorClass,
    maxRetries,
  });
  if (!claim.claimed || !claim.verdictId) {
    // Replay of already-judged (or in-flight) evidence: never re-bill, never re-act.
    log.debug({ runId: record.runId, headSha }, 'overseer.judge_first.claim_not_won');
    return;
  }

  const events = await deps.listRunEvents(record.runId);
  const envelope = buildEvidenceEnvelope(record, events);
  const digest = envelopeDigest(envelope);

  const judge = options.judge ?? judgeTerminalRun;
  const outcome = await judge(envelope, options.judgeOptions);

  if (outcome.kind !== 'verdict') {
    // Judge health failure: an operational ALARM, never a semantic verdict.
    await options.verdictStore.finalizeVerdict({
      verdictId: claim.verdictId,
      status: outcome.kind,
      model: outcome.model,
      modelRung: outcome.modelRung,
      reason: outcome.reason,
      evidenceDigest: digest,
    });
    log.error(
      {
        runId: record.runId,
        verdictId: claim.verdictId,
        state: outcome.kind,
        reason: outcome.reason,
        retryCount: claim.retryCount ?? 0,
      },
      'overseer.judge_first.judge_health_alarm'
    );
    if ((claim.retryCount ?? 0) >= maxRetries) {
      // Retry budget exhausted: escalate loudly and write the receipt row so the
      // run stops re-entering the queue as a permanent zombie.
      await escalateWithEvidence(
        record,
        deps,
        events,
        {
          verdictId: claim.verdictId,
          reason: `judge_health_${outcome.kind}`,
          blocker: `Overseer judge health failure (${outcome.kind}) after ${claim.retryCount} retries: ${outcome.reason}`,
        },
        options.escalate
      );
    }
    return;
  }

  const ruling: TierRuling = ruleOnAction(outcome.proposedAction, outcome.proposedTier);
  await options.verdictStore.finalizeVerdict({
    verdictId: claim.verdictId,
    status: 'verdict',
    verdict: outcome.verdict,
    confidence: outcome.confidence,
    model: outcome.model,
    modelRung: outcome.modelRung,
    proposedAction: outcome.proposedAction,
    proposedTier: outcome.proposedTier,
    requiredTier: ruling.requiredTier,
    effectiveTier: ruling.effectiveTier,
    reason: outcome.reason,
    evidenceDigest: digest,
    evidence: JSON.stringify(envelope),
  });

  // Tier 0 action 1 (mandatory): verdict_write receipt. This is also what
  // retires the run from the watch queue.
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: actionClass(record),
    action: 'verdict_write',
    result: `verdict:${claim.verdictId}:${outcome.verdict}:confidence:${outcome.confidence}`,
  });
  log.info(
    {
      runId: record.runId,
      woId: record.woId,
      verdictId: claim.verdictId,
      verdict: outcome.verdict,
      confidence: outcome.confidence,
      model: outcome.model,
      proposedAction: outcome.proposedAction,
      effectiveTier: ruling.effectiveTier,
    },
    'overseer.judge_first.verdict_completed'
  );

  // Tier >= 1 proposals are refused with a recorded refusal (v1 = Tier 0 only).
  if (
    !ruling.executableInV1 &&
    outcome.proposedAction !== 'none' &&
    outcome.proposedAction !== 'verdict_write'
  ) {
    if (ruling.effectiveTier > 0) {
      await deps.insertOverseerAction({
        runId: record.runId,
        woId: record.woId,
        class: actionClass(record),
        action: 'tier_refused',
        result: `action:${outcome.proposedAction}:required_tier:${ruling.requiredTier}:effective_tier:${ruling.effectiveTier}:verdict:${claim.verdictId}`,
      });
      return;
    }
  }

  // flag_merge_ready: steward handoff. The judge's merge_candidate reading is
  // necessary but not sufficient -- the deterministic PR gate must ALSO hold
  // (fail-closed remains correct for merge). No merge happens here; the
  // coordinator path keeps every downstream guard including merge=0.
  if (outcome.verdict === 'merge_candidate' && isPrMergeReady(record.prEvidence)) {
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: actionClass(record),
      action: 'flag_merge_ready',
      result: `steward_handoff:verdict:${claim.verdictId}${options.dryRun ? ':dry_run' : ''}`,
    });
    if (!options.dryRun && options.mergeCoordinator) {
      await options.mergeCoordinator(record);
    }
    return;
  }

  if (
    outcome.verdict === 'needs_human' ||
    outcome.verdict === 'failed_genuine' ||
    outcome.proposedAction === 'escalate_with_evidence'
  ) {
    await escalateWithEvidence(
      record,
      deps,
      events,
      {
        verdictId: claim.verdictId,
        reason: `verdict_${outcome.verdict}`,
        blocker: outcome.reason || `Overseer verdict ${outcome.verdict} on run ${record.runId}`,
      },
      options.escalate
    );
    return;
  }

  if (outcome.proposedAction === 'comment_findings' || outcome.verdict === 'duplicate_work') {
    await commentFindings(record, deps, {
      verdictId: claim.verdictId,
      verdict: outcome.verdict,
      reason: outcome.reason,
      dryRun: options.dryRun,
    });
    return;
  }
  // healthy / observe: the mandatory verdict_write receipt above IS the record.
}
