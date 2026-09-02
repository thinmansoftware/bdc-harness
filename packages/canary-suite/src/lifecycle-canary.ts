import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { execFile as execFileCallback } from 'child_process';
import { link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import type { CanaryVerdict } from './types';

const execFile = promisify(execFileCallback);
export const LIFECYCLE_LEG_COUNT = 10;
export const PLANTED_DEFECT_LITERAL = 'WRONG_VALUE';

export interface LifecycleCanaryDatabase {
  query<T>(sql: string): { all(...params: unknown[]): T[]; get(...params: unknown[]): T | null };
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr?: string;
}

export interface LifecycleLegResult {
  readonly leg: number;
  readonly name: string;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface LifecycleCanaryResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly generatedAt: string;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly legs: readonly LifecycleLegResult[];
}

export interface LifecycleCanaryDeps {
  readonly runId: string;
  readonly apiBase: string;
  readonly codebaseId: string;
  readonly dbPath?: string;
  readonly db?: LifecycleCanaryDatabase;
  readonly githubRepo: string;
  readonly githubIssue: number;
  readonly operatorToken?: string;
  readonly now?: () => number;
  readonly command?: (file: string, args: readonly string[]) => Promise<CommandResult>;
  readonly dispatchMessageId?: string;
  readonly dutyOfficerArtifact?: string;
  readonly preRunBlob?: string;
  readonly remediationSha?: string;
  readonly remediationCommittedAt?: string;
  readonly prNumber?: number;
  readonly skipTaskmasterWait?: boolean;
}

interface JournalRow {
  readonly id: string;
  readonly created_at: string;
}
interface DispatchRow {
  readonly result_body: string | null;
}

function result(
  leg: number,
  name: string,
  verdict: CanaryVerdict,
  reason: string | null,
  evidence: readonly string[]
): LifecycleLegResult {
  return { leg, name, verdict, reasonCodes: reason ? [reason] : [], evidenceRefs: evidence };
}

function passed(leg: number, name: string, evidence: readonly string[]): LifecycleLegResult {
  return result(leg, name, 'passed', null, evidence);
}

function failed(
  leg: number,
  name: string,
  reason: string,
  evidence: readonly string[]
): LifecycleLegResult {
  return result(leg, name, 'failed', reason, evidence);
}

function blocked(
  leg: number,
  name: string,
  reason: string,
  evidence: readonly string[]
): LifecycleLegResult {
  return result(leg, name, 'blocked', reason, evidence);
}

function command(
  deps: LifecycleCanaryDeps
): (file: string, args: readonly string[]) => Promise<CommandResult> {
  return (
    deps.command ??
    (async (file: string, args: readonly string[]): Promise<CommandResult> => {
      const value = await execFile(file, [...args], { maxBuffer: 10 * 1024 * 1024 });
      return { stdout: value.stdout, stderr: value.stderr };
    })
  );
}

function database(deps: LifecycleCanaryDeps): { db: LifecycleCanaryDatabase; close: () => void } {
  if (deps.db) return { db: deps.db, close: () => undefined };
  if (!deps.dbPath) throw new Error('lifecycle_canary_db_path_required');
  const db = new Database(deps.dbPath, { readonly: true });
  return {
    db,
    close: (): void => {
      db.close();
    },
  };
}

async function ghJson<T>(deps: LifecycleCanaryDeps, args: readonly string[]): Promise<T> {
  return JSON.parse((await command(deps)('gh', args)).stdout) as T;
}

async function fileTriageIssue(
  deps: LifecycleCanaryDeps,
  title: string,
  body: string
): Promise<string> {
  try {
    const response = await command(deps)('gh', [
      'issue',
      'create',
      '--repo',
      deps.githubRepo,
      '--title',
      title,
      '--body',
      body,
    ]);
    return `triage_issue=${response.stdout.trim()}`;
  } catch (error) {
    return `triage_issue_error=${(error as Error).message}`;
  }
}

export function createPlantedDefect(runId: string): string {
  return `// lifecycle canary ${runId}; expected echo: ${runId}\nexport const CANARY_RUN_ID_ECHO = "${PLANTED_DEFECT_LITERAL}";\n`;
}

export async function runLeg1TaskmasterFire(
  deps: LifecycleCanaryDeps,
  startedAt: string
): Promise<LifecycleLegResult> {
  const name = 'Taskmaster proposes and dispatches';
  let opened: ReturnType<typeof database>;
  try {
    opened = database(deps);
  } catch (error) {
    return blocked(1, name, 'taskmaster_never_fires', [
      `error=${(error as Error).message}`,
      'fallback=fire.ps1 requires operator',
    ]);
  }
  try {
    const rows = opened.db
      .query<JournalRow>(
        "SELECT id, created_at FROM tm_journal WHERE proposal_type='fire_cauldron' AND target=? AND created_at>? ORDER BY id DESC LIMIT 5"
      )
      .all(String(deps.githubIssue), startedAt);
    if (rows.length === 0)
      return blocked(1, name, 'taskmaster_never_fires', [
        'tm_journal.rows=0',
        'fallback=fire.ps1 requires operator',
      ]);
    return passed(
      1,
      name,
      rows.map(row => `tm_journal.id=${row.id};created_at=${row.created_at}`)
    );
  } catch (error) {
    return blocked(1, name, 'taskmaster_never_fires', [
      `tm_journal.error=${(error as Error).message}`,
      'fallback=fire.ps1 requires operator',
    ]);
  } finally {
    opened.close();
  }
}

export async function runLeg2CodexLaneBuild(
  deps: LifecycleCanaryDeps
): Promise<LifecycleLegResult> {
  const name = 'codex lane builds and opens PR';
  const head = `canary/lifecycle-${deps.runId}`;
  try {
    const prs = await ghJson<
      { number: number; headRefName: string; baseRefName: string; state: string }[]
    >(deps, [
      'pr',
      'list',
      '--repo',
      deps.githubRepo,
      '--head',
      head,
      '--base',
      'dev',
      '--json',
      'number,headRefName,baseRefName,state',
    ]);
    if (prs.length !== 1) {
      const triage = await fileTriageIssue(
        deps,
        `Lifecycle canary ${deps.runId}: codex lane opened ${prs.length} PRs`,
        `Run ${deps.runId} expected exactly one PR for ${head}; observed ${prs.length}.`
      );
      return failed(2, name, 'codex_lane_no_pr', [`pr_count=${prs.length}`, triage]);
    }
    return passed(2, name, [
      `pr.number=${prs[0].number}`,
      `head=${prs[0].headRefName}`,
      `base=${prs[0].baseRefName}`,
      `state=${prs[0].state}`,
    ]);
  } catch (error) {
    return failed(2, name, 'codex_lane_no_pr', [`gh.error=${(error as Error).message}`]);
  }
}

interface Review {
  state: string;
  body?: string;
  submitted_at?: string;
  user?: { login?: string };
}
export async function runLeg3OverseerDefectReview(
  deps: LifecycleCanaryDeps
): Promise<LifecycleLegResult> {
  const name = 'Overseer catches planted defect';
  try {
    const reviews = await ghJson<Review[]>(deps, [
      'api',
      `repos/${deps.githubRepo}/pulls/${deps.prNumber}/reviews`,
    ]);
    const review = reviews.find(
      item =>
        item.state === 'CHANGES_REQUESTED' && (item.body ?? '').includes(PLANTED_DEFECT_LITERAL)
    );
    if (!review) {
      const triage = await fileTriageIssue(
        deps,
        `Lifecycle canary ${deps.runId}: Overseer missed planted defect`,
        `No CHANGES_REQUESTED review named ${PLANTED_DEFECT_LITERAL}.`
      );
      return failed(3, name, 'overseer_missed_planted_defect', [
        `reviews=${reviews.length}`,
        triage,
      ]);
    }
    return passed(3, name, [
      `review.state=${review.state}`,
      `signature=${PLANTED_DEFECT_LITERAL}`,
      `submitted_at=${review.submitted_at ?? 'unknown'}`,
    ]);
  } catch (error) {
    return failed(3, name, 'overseer_missed_planted_defect', [
      `gh.error=${(error as Error).message}`,
    ]);
  }
}

export async function runLeg4Remediation(deps: LifecycleCanaryDeps): Promise<LifecycleLegResult> {
  const name = 'remediation reaches PR';
  try {
    const view = await ghJson<{ commits: { oid?: string }[] }>(deps, [
      'pr',
      'view',
      String(deps.prNumber),
      '--repo',
      deps.githubRepo,
      '--json',
      'commits',
    ]);
    const diff = (
      await command(deps)('gh', ['pr', 'diff', String(deps.prNumber), '--repo', deps.githubRepo])
    ).stdout;
    if (diff.includes(PLANTED_DEFECT_LITERAL))
      return blocked(4, name, 'manual_remediation_required', [
        `commit_count=${view.commits.length}`,
        'signature_present=true',
        'gap=bdc-xo#1835',
      ]);
    return passed(4, name, [
      `commit_count=${view.commits.length}`,
      'signature_present=false',
      'fallback=assigned_owner',
    ]);
  } catch (error) {
    return blocked(4, name, 'manual_remediation_required', [
      `error=${(error as Error).message}`,
      'gap=bdc-xo#1835',
    ]);
  }
}

export async function runLeg5OverseerReapproval(
  deps: LifecycleCanaryDeps
): Promise<LifecycleLegResult> {
  const name = 'Overseer re-approves on push';
  if (!deps.remediationSha)
    return failed(5, name, 'overseer_resync_trigger_not_firing', ['remediation_sha=missing']);
  let opened: ReturnType<typeof database>;
  try {
    opened = database(deps);
  } catch (error) {
    return failed(5, name, 'overseer_resync_trigger_not_firing', [
      `error=${(error as Error).message}`,
    ]);
  }
  try {
    const trigger = opened.db
      .query<{
        id: string;
      }>(
        "SELECT id FROM agent_dispatch_messages WHERE task_type='run_review' AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(`%${deps.remediationSha}%`);
    if (!trigger)
      return failed(5, name, 'overseer_resync_trigger_not_firing', [
        `head_sha=${deps.remediationSha}`,
        'run_review.rows=0',
      ]);
    const reviews = await ghJson<Review[]>(deps, [
      'api',
      `repos/${deps.githubRepo}/pulls/${deps.prNumber}/reviews`,
    ]);
    const approved = [...reviews]
      .reverse()
      .find(
        item =>
          item.state === 'APPROVED' &&
          (!deps.remediationCommittedAt || (item.submitted_at ?? '') > deps.remediationCommittedAt)
      );
    return approved
      ? passed(5, name, [
          `run_review.id=${trigger.id}`,
          `approved_at=${approved.submitted_at ?? 'unknown'}`,
        ])
      : failed(5, name, 'overseer_no_reapproval', [
          `run_review.id=${trigger.id}`,
          'approval=missing',
        ]);
  } catch (error) {
    return failed(5, name, 'overseer_no_reapproval', [`error=${(error as Error).message}`]);
  } finally {
    opened.close();
  }
}

export async function runLeg6AutonomousMerge(
  deps: LifecycleCanaryDeps
): Promise<LifecycleLegResult> {
  const name = 'Merge Manager merges autonomously';
  try {
    const pr = await ghJson<{
      state: string;
      mergedBy: { login: string } | null;
      mergeCommit: { oid: string } | null;
      files?: { path: string }[];
    }>(deps, [
      'pr',
      'view',
      String(deps.prNumber),
      '--repo',
      deps.githubRepo,
      '--json',
      'state,mergedBy,mergeCommit,files',
    ]);
    const outside = (pr.files ?? []).filter(
      file => !file.path.startsWith('.archon/canaries/lifecycle-scratch/')
    );
    if (outside.length)
      return failed(
        6,
        name,
        'canary_diff_scope_violation',
        outside.map(file => `path=${file.path}`)
      );
    if (pr.state !== 'MERGED')
      return failed(6, name, 'merge_manager_did_not_merge', [`state=${pr.state}`]);
    if (pr.mergedBy?.login !== 'bluedevilcollectibles')
      return failed(6, name, 'human_merged_not_autonomous', [
        `merged_by=${pr.mergedBy?.login ?? 'unknown'}`,
      ]);
    return passed(6, name, [
      `merged_by=${pr.mergedBy.login}`,
      `merge_sha=${pr.mergeCommit?.oid ?? 'unknown'}`,
    ]);
  } catch (error) {
    return failed(6, name, 'merge_manager_did_not_merge', [`gh.error=${(error as Error).message}`]);
  }
}

export async function runLeg7Reconcile(deps: LifecycleCanaryDeps): Promise<LifecycleLegResult> {
  const name = 'reconcile closes issue';
  try {
    const issue = await ghJson<{ state: string; stateReason?: string }>(deps, [
      'issue',
      'view',
      String(deps.githubIssue),
      '--repo',
      deps.githubRepo,
      '--json',
      'state,stateReason',
    ]);
    return issue.state === 'CLOSED'
      ? passed(7, name, [`state=${issue.state}`, `stateReason=${issue.stateReason ?? 'unknown'}`])
      : failed(7, name, 'reconcile_did_not_close', [`state=${issue.state}`]);
  } catch (error) {
    return failed(7, name, 'reconcile_did_not_close', [`gh.error=${(error as Error).message}`]);
  }
}

export async function runLeg8DispatchReply(deps: LifecycleCanaryDeps): Promise<LifecycleLegResult> {
  const name = 'Dispatch delivers readable reply';
  if (!deps.dispatchMessageId)
    return failed(8, name, 'dispatch_reply_unreadable', ['dispatch_message_id=missing']);
  let opened: ReturnType<typeof database>;
  try {
    opened = database(deps);
  } catch (error) {
    return failed(8, name, 'dispatch_reply_unreadable', [`error=${(error as Error).message}`]);
  }
  try {
    const row = opened.db
      .query<DispatchRow>('SELECT result_body FROM agent_dispatch_messages WHERE id=?')
      .get(deps.dispatchMessageId);
    const body = row?.result_body?.trim() ?? '';
    const readable =
      body.includes(deps.runId) && !/^sha256:[a-f0-9]+(?:\s+\d+ bytes)?$/i.test(body);
    return readable
      ? passed(8, name, [
          `message_id=${deps.dispatchMessageId}`,
          `result_body_bytes=${body.length}`,
        ])
      : failed(8, name, 'dispatch_reply_unreadable', [
          `message_id=${deps.dispatchMessageId}`,
          `result_body=${body || 'missing'}`,
        ]);
  } catch (error) {
    return failed(8, name, 'dispatch_reply_unreadable', [`error=${(error as Error).message}`]);
  } finally {
    opened.close();
  }
}

export async function runLeg9DutyOfficer(deps: LifecycleCanaryDeps): Promise<LifecycleLegResult> {
  const name = 'Duty Officer reports run';
  if (!deps.dutyOfficerArtifact)
    return failed(9, name, 'do_did_not_see_run', ['duty_officer_artifact=missing']);
  try {
    const output = await readFile(deps.dutyOfficerArtifact, 'utf8');
    if (!output.includes(deps.runId))
      return failed(9, name, 'do_did_not_see_run', [`artifact=${deps.dutyOfficerArtifact}`]);
    const runLines = output.split('\n').filter(line => line.includes(deps.runId));
    if (runLines.some(line => /stale|idle arc|nudge/i.test(line)))
      return failed(9, name, 'do_flagged_canary_stale', runLines);
    return passed(9, name, [
      `artifact=${deps.dutyOfficerArtifact}`,
      `run_mentions=${runLines.length}`,
    ]);
  } catch (error) {
    return failed(9, name, 'do_did_not_see_run', [`error=${(error as Error).message}`]);
  }
}

export async function runLeg10Revert(deps: LifecycleCanaryDeps): Promise<LifecycleLegResult> {
  const name = 'canary reverts itself';
  try {
    const path = `.archon/canaries/lifecycle-scratch/canary-marker-${deps.runId}.ts`;
    const tracked = (
      await command(deps)('git', ['ls-tree', '-r', '--name-only', 'origin/dev', '--', path])
    ).stdout.trim();
    const current =
      deps.preRunBlob === undefined
        ? ''
        : (await command(deps)('git', ['show', `origin/dev:${path}`])).stdout;
    if (tracked || (deps.preRunBlob !== undefined && current !== deps.preRunBlob))
      return failed(10, name, 'canary_left_residue_on_dev', [
        `tracked=${tracked || 'none'}`,
        `pre_run_blob_match=${current === deps.preRunBlob}`,
      ]);
    return passed(10, name, [`path=${path}`, 'tracked=false', 'pre_run_blob_match=true']);
  } catch (error) {
    return failed(10, name, 'canary_left_residue_on_dev', [`error=${(error as Error).message}`]);
  }
}

export async function runLifecycleCanarySuite(
  deps: LifecycleCanaryDeps
): Promise<LifecycleCanaryResult> {
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const first = await runLeg1TaskmasterFire(deps, startedAt);
  let legs: LifecycleLegResult[];
  if (first.verdict === 'blocked') {
    legs = [
      first,
      ...Array.from({ length: 9 }, (_, index) =>
        blocked(
          index + 2,
          [
            'codex lane builds and opens PR',
            'Overseer catches planted defect',
            'remediation reaches PR',
            'Overseer re-approves on push',
            'Merge Manager merges autonomously',
            'reconcile closes issue',
            'Dispatch delivers readable reply',
            'Duty Officer reports run',
            'canary reverts itself',
          ][index],
          'fallback_requires_operator',
          ['fallback=fire.ps1 not executed by build container']
        )
      ),
    ];
  } else {
    legs = [first];
    const runners = [
      runLeg2CodexLaneBuild,
      runLeg3OverseerDefectReview,
      runLeg4Remediation,
      runLeg5OverseerReapproval,
      runLeg6AutonomousMerge,
      runLeg7Reconcile,
      runLeg8DispatchReply,
      runLeg9DutyOfficer,
      runLeg10Revert,
    ];
    for (const runner of runners) legs.push(await runner(deps));
  }
  const reasonCodes = legs.flatMap(leg => leg.reasonCodes);
  const verdict: CanaryVerdict = legs.some(leg => leg.verdict === 'failed')
    ? 'failed'
    : legs.some(leg => leg.verdict === 'blocked')
      ? 'blocked'
      : 'passed';
  return {
    schemaVersion: 1,
    runId: deps.runId,
    startedAt,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    verdict,
    reasonCodes,
    evidenceRefs: legs.flatMap(leg => leg.evidenceRefs),
    legs,
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeLifecycleCanaryArtifacts(
  outputRoot: string,
  report: LifecycleCanaryResult
): Promise<string[]> {
  const directory = join(outputRoot, report.runId);
  const path = join(directory, 'summary.md');
  const rows = report.legs
    .map(
      leg =>
        `| ${leg.leg} | ${leg.name} | ${leg.verdict} | ${leg.reasonCodes.join(', ') || '-'} | ${leg.evidenceRefs.join('<br>') || '-'} |`
    )
    .join('\n');
  const content = `# Lifecycle canary ${report.runId}\n\nVerdict: **${report.verdict}**\n\n| Leg | Name | Verdict | Reason | Artifact evidence |\n|---:|---|---|---|---|\n${rows}\n`;
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((await readIfPresent(path)) !== content) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return [path];
}
