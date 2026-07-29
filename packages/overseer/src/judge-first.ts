/**
 * Judge-first decision core (Motion M-99, WO-HARNESS-OVERSEER-V2-JUDGE-FIRST-01).
 *
 * Every terminal run gets model eyes on a bounded evidence envelope, and every
 * read leaves a row. Thinking is never gated; only DOING is (tier-map.ts).
 *
 * Judge health is FAIL-LOUD (binding term 2): transport death, unparseable
 * output, and missing evidence are distinct operational alarm states with
 * model-ladder retry -- NEVER converted into a semantic verdict. This module
 * deliberately does NOT reuse judge-second-opinion.ts, whose collapse of every
 * failure mode into a cautious-looking HOLD is the defect both design-round
 * seats independently identified as the killer.
 *
 * Cost containment (design round, binding): bounded envelope (fixed schema,
 * capped event tail), terminal-only judging, claim-before-call idempotency
 * (db layer), and a daily budget circuit that degrades LOUDLY to an alarm
 * state -- never a silent stop.
 */

import { createHash } from 'crypto';
import { createLogger } from '@archon/paths';
import type { OverseerWorkflowEvent, PullRequestEvidence, WatchedRunRecord } from './types.ts';

const log = createLogger('overseer/judge-first');

const DEFAULT_TIMEOUT_MS = 120_000;
const EVENT_TAIL_LIMIT = 20;
const EVENT_MESSAGE_CAP = 400;
const DEFAULT_DAILY_BUDGET_CALLS = 200;

export const SEMANTIC_VERDICTS = [
  'healthy',
  'merge_candidate',
  'failed_genuine',
  'duplicate_work',
  'needs_human',
  'observe',
] as const;
export type SemanticVerdict = (typeof SEMANTIC_VERDICTS)[number];

export type JudgeHealthState =
  | 'judge_unavailable'
  | 'judge_invalid_output'
  | 'evidence_unavailable';

export interface JudgeEvidenceEnvelope {
  runId: string;
  woId: string;
  status: string;
  repository: string;
  headBranch: string | null;
  headSha: string;
  pr: {
    exists: boolean;
    state: string;
    mergeable: boolean | null;
    lookupFailed: boolean;
    checks: PullRequestEvidence['checks'];
    url: string | null;
  };
  /** Classifier output, demoted to advisory hint fields (binding term: no gate). */
  hint: { action: string; errorClass: string | null; reason: string };
  eventTail: { type: string; step: string | null; at: string; message: string }[];
}

export interface JudgeVerdictOutcome {
  kind: 'verdict';
  verdict: SemanticVerdict;
  confidence: number;
  proposedAction: string;
  proposedTier: number;
  reason: string;
  model: string;
  modelRung: number;
}

export interface JudgeAlarmOutcome {
  kind: JudgeHealthState;
  reason: string;
  model?: string;
  modelRung?: number;
}

export type JudgeOutcome = JudgeVerdictOutcome | JudgeAlarmOutcome;

export interface JudgeSpawnResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

export interface JudgeFirstOptions {
  /** Ladder rung binaries, cheapest first. Default: env OVERSEER_JUDGE_LADDER or ['grok']. */
  ladder?: string[];
  timeoutMs?: number;
  spawn?: (binary: string, prompt: string) => Promise<JudgeSpawnResult>;
  budget?: JudgeBudgetCircuit;
}

/**
 * Daily budget circuit. Breach does NOT silently stop the watcher: the caller
 * receives an evidence_unavailable alarm and escalates (design-round rule:
 * degrade to R0-only + escalate-to-human, never silent stop). In-memory state
 * resets on process restart; the persistent backstop is the claim table, which
 * caps total calls at (runs x retries) regardless of this circuit. Recorded as
 * an open condition in the M-94 control-surface record.
 */
export class JudgeBudgetCircuit {
  private day: string;
  private calls = 0;
  constructor(
    private readonly dailyLimit: number = readDailyBudget(),
    private readonly clock: () => Date = () => new Date()
  ) {
    this.day = this.today();
  }
  private today(): string {
    return this.clock().toISOString().slice(0, 10);
  }
  private roll(): void {
    const today = this.today();
    if (today !== this.day) {
      this.day = today;
      this.calls = 0;
    }
  }
  tryConsume(): boolean {
    this.roll();
    if (this.calls >= this.dailyLimit) return false;
    this.calls += 1;
    return true;
  }
  get spentToday(): number {
    this.roll();
    return this.calls;
  }
}

function readDailyBudget(): number {
  const raw = Number(process.env.OVERSEER_JUDGE_DAILY_BUDGET_CALLS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET_CALLS;
}

export function defaultJudgeLadder(): string[] {
  const raw = process.env.OVERSEER_JUDGE_LADDER ?? 'grok';
  const rungs = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return rungs.length > 0 ? rungs : ['grok'];
}

function truncate(value: string, cap: number): string {
  return value.length > cap ? `${value.slice(0, cap)}...` : value;
}

function eventMessage(data: Record<string, unknown>): string {
  const candidates = [data.error, data.message, data.stderr, data.output, data.reason];
  const found = candidates.find(value => typeof value === 'string' && value.trim());
  if (typeof found === 'string') return found;
  try {
    return JSON.stringify(data);
  } catch {
    return '[unserializable event data]';
  }
}

/**
 * Build the bounded evidence envelope. Fixed schema, last N events, truncated
 * messages -- never a full transcript dump (cost containment is load-bearing).
 */
export function buildEvidenceEnvelope(
  record: WatchedRunRecord,
  events: OverseerWorkflowEvent[]
): JudgeEvidenceEnvelope {
  const tail = events.slice(-EVENT_TAIL_LIMIT).map(event => ({
    type: event.event_type,
    step: event.step_name,
    at: event.created_at ?? '',
    message: truncate(eventMessage(event.data), EVENT_MESSAGE_CAP),
  }));
  return {
    runId: record.runId,
    woId: record.woId,
    status: record.status,
    repository: record.owner && record.repo ? `${record.owner}/${record.repo}` : 'unknown',
    headBranch: record.headBranch ?? null,
    headSha: record.prEvidence.headSha ?? '',
    pr: {
      exists: record.prEvidence.exists,
      state: record.prEvidence.state,
      mergeable: record.prEvidence.mergeable,
      lookupFailed: record.prEvidence.lookupFailed ?? false,
      checks: record.prEvidence.checks,
      url: record.prEvidence.htmlUrl ?? null,
    },
    hint: {
      action: record.action,
      errorClass: record.errorClass ?? null,
      reason: record.reason,
    },
    eventTail: tail,
  };
}

export function envelopeDigest(envelope: JudgeEvidenceEnvelope): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

export function buildJudgePrompt(envelope: JudgeEvidenceEnvelope): string {
  return [
    'You are the Overseer judge for the BDC Cauldron build harness. A workflow run has',
    'reached a terminal state. Read the evidence holistically and return a verdict.',
    '',
    'Respond with EXACTLY one JSON object and nothing else, using this schema:',
    '{"verdict":"healthy|merge_candidate|failed_genuine|duplicate_work|needs_human|observe",',
    ' "confidence":0.0-1.0,',
    ' "proposed_action":"verdict_write|comment_findings|flag_merge_ready|escalate_with_evidence|none",',
    ' "proposed_tier":0,',
    ' "reason":"one or two sentences citing the load-bearing evidence"}',
    '',
    'Guidance: merge_candidate ONLY when a green, open, mergeable PR exists for this',
    'run; failed_genuine when the run failed and no salvageable work exists;',
    'duplicate_work when the evidence shows this WO already has an equivalent open PR;',
    'needs_human when evidence conflicts or the failure shape is unrecognized;',
    'observe/healthy for uneventful terminal runs. The deterministic classifier hint',
    'below is ADVISORY ONLY -- you may contradict it, and say so in reason when you do.',
    '',
    'EVIDENCE ENVELOPE (JSON):',
    JSON.stringify(envelope, null, 2),
  ].join('\n');
}

interface ParsedJudgeVerdict {
  verdict: SemanticVerdict;
  confidence: number;
  proposedAction: string;
  proposedTier: number;
  reason: string;
}

/** Strict parse: first JSON object in stdout, validated field by field. */
export function parseJudgeOutput(stdout: string): ParsedJudgeVerdict | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== 'string' || !(SEMANTIC_VERDICTS as readonly string[]).includes(verdict)) {
    return null;
  }
  const confidence = obj.confidence;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;
  const proposedAction = typeof obj.proposed_action === 'string' ? obj.proposed_action : 'none';
  const proposedTierRaw = obj.proposed_tier;
  const proposedTier =
    typeof proposedTierRaw === 'number' && Number.isInteger(proposedTierRaw) && proposedTierRaw >= 0
      ? proposedTierRaw
      : 0;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { verdict: verdict as SemanticVerdict, confidence, proposedAction, proposedTier, reason };
}

async function spawnJudgeBinary(
  binary: string,
  prompt: string,
  timeoutMs: number
): Promise<JudgeSpawnResult> {
  const subprocess = Bun.spawn([binary, '-p', prompt], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timeout: Timer | undefined;
  const timeoutResult = new Promise<JudgeSpawnResult>(resolve => {
    timeout = setTimeout(() => {
      subprocess.kill();
      resolve({ exitCode: 124, stdout: '', timedOut: true });
    }, timeoutMs);
  });
  const processResult = (async (): Promise<JudgeSpawnResult> => {
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);
    return { exitCode, stdout, timedOut: false };
  })();
  const result = await Promise.race([processResult, timeoutResult]);
  if (timeout) clearTimeout(timeout);
  return result;
}

/**
 * Judge a terminal run through the model ladder. Rungs are tried cheapest
 * first; each distinct failure mode is tracked separately so the exhausted
 * outcome reports what actually happened (transport death vs invalid output),
 * not a blended guess.
 */
export async function judgeTerminalRun(
  envelope: JudgeEvidenceEnvelope,
  options: JudgeFirstOptions = {}
): Promise<JudgeOutcome> {
  const ladder = options.ladder ?? defaultJudgeLadder();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn =
    options.spawn ??
    ((binary: string, prompt: string): Promise<JudgeSpawnResult> =>
      spawnJudgeBinary(binary, prompt, timeoutMs));
  const budget = options.budget;

  const prompt = buildJudgePrompt(envelope);
  let sawInvalidOutput = false;
  let lastModel: string | undefined;
  let lastRung = -1;

  for (let rung = 0; rung < ladder.length; rung += 1) {
    const binary = ladder[rung];
    if (!binary) continue;
    lastModel = binary;
    lastRung = rung;
    if (budget && !budget.tryConsume()) {
      log.error(
        { runId: envelope.runId, rung, binary, spentToday: budget.spentToday },
        'overseer.judge_first.budget_circuit_open'
      );
      return {
        kind: 'evidence_unavailable',
        reason: 'judge_daily_budget_exhausted',
        model: binary,
        modelRung: rung,
      };
    }
    try {
      const result = await spawn(binary, prompt);
      if (result.timedOut || result.exitCode !== 0) {
        log.error(
          {
            runId: envelope.runId,
            rung,
            binary,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          },
          'overseer.judge_first.rung_unavailable'
        );
        continue;
      }
      const parsed = parseJudgeOutput(result.stdout);
      if (!parsed) {
        sawInvalidOutput = true;
        log.error(
          { runId: envelope.runId, rung, binary, stdoutPreview: result.stdout.slice(0, 200) },
          'overseer.judge_first.rung_invalid_output'
        );
        continue;
      }
      return {
        kind: 'verdict',
        verdict: parsed.verdict,
        confidence: parsed.confidence,
        proposedAction: parsed.proposedAction,
        proposedTier: parsed.proposedTier,
        reason: parsed.reason,
        model: binary,
        modelRung: rung,
      };
    } catch (error) {
      log.error(
        { err: error as Error, runId: envelope.runId, rung, binary },
        'overseer.judge_first.rung_spawn_failed'
      );
      continue;
    }
  }

  // Ladder exhausted: an ALARM, never a semantic verdict (binding term 2).
  return {
    kind: sawInvalidOutput ? 'judge_invalid_output' : 'judge_unavailable',
    reason: sawInvalidOutput
      ? `all ${ladder.length} ladder rung(s) returned unparseable output`
      : `all ${ladder.length} ladder rung(s) unavailable (spawn failure, timeout, or nonzero exit)`,
    model: lastModel,
    modelRung: lastRung >= 0 ? lastRung : undefined,
  };
}
