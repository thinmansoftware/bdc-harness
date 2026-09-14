import { readFile } from 'fs/promises';
import { runCanary, type RunCanaryOptions } from './runner';
import type { RunCanaryResult } from './types';
import {
  runTaskmasterCanarySuite,
  writeTaskmasterCanaryArtifacts,
  type TaskmasterCanaryDeps,
  type TaskmasterCanaryResult,
} from './taskmaster-canary';
import {
  createRealOctokitClient,
  type RealGitHubOctokitLike,
} from '@archon/overseer/adapters/github-real-deps';
import {
  runPrReviewCanarySuite,
  writePrReviewCanaryArtifacts,
  type PrReviewCanaryDeps,
} from './pr-review-canary';
import { createGateNotDeadGitHubAdapter, type GateNotDeadGitHub } from './gate-not-dead-canary';
import type { OutcomeCanaryResult } from './outcome-canary';

interface CanaryCliDeps {
  readonly runner: (options: RunCanaryOptions) => Promise<RunCanaryResult>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly taskmasterRunner?: (options: TaskmasterCanaryDeps) => Promise<TaskmasterCanaryResult>;
  readonly taskmasterArtifactWriter?: (
    outputRoot: string,
    report: TaskmasterCanaryResult
  ) => Promise<readonly string[]>;
  readonly prReviewRunner?: (options: PrReviewCanaryDeps) => Promise<OutcomeCanaryResult>;
  readonly prReviewArtifactWriter?: (
    outputRoot: string,
    report: OutcomeCanaryResult
  ) => Promise<readonly string[]>;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

/** C6 needs the App-authenticated client; a PAT is never a fallback. */
function githubAppConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  const appId = (env.GITHUB_APP_ID ?? '').trim();
  const installationId = (env.GITHUB_APP_INSTALLATION_ID ?? '').trim();
  const privateKey = (env.GITHUB_APP_PRIVATE_KEY ?? '').trim();
  const privateKeyPath = (env.GITHUB_APP_PRIVATE_KEY_PATH ?? '').trim();
  return appId !== '' && installationId !== '' && (privateKey !== '' || privateKeyPath !== '');
}

function tryCreatePrReviewGithub(
  env: Readonly<Record<string, string | undefined>>
): GateNotDeadGitHub | undefined {
  if (!githubAppConfigured(env)) return undefined;
  try {
    const octokit: RealGitHubOctokitLike = createRealOctokitClient();
    return createGateNotDeadGitHubAdapter(octokit);
  } catch {
    return undefined;
  }
}

function printBlockedCanaries(report: OutcomeCanaryResult, stderr: (value: string) => void): void {
  const blocked = (report.checks ?? []).filter(check => check.verdict === 'blocked');
  if (blocked.length > 0) {
    stderr(
      `blocked canaries: ${blocked
        .map(check => `${check.id ?? 'check'}:${check.reasonCodes.join(',')}`)
        .join(' ')}`
    );
    return;
  }
  if (report.verdict === 'blocked') {
    stderr(`blocked canaries: ${report.reasonCodes.join(' ')}`);
  }
}

function exitFor(verdict: RunCanaryResult['report']['verdict']): number {
  return {
    passed: 0,
    probe_passed: 0,
    failed: 2,
    probe_failed: 2,
    build_failed: 2,
    blocked: 3,
    aborted: 4,
    static_only: 5,
  }[verdict];
}

export async function runCanaryCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: CanaryCliDeps = {
    runner: runCanary,
    stdout: value => process.stdout.write(`${value}\n`),
    stderr: value => process.stderr.write(`${value}\n`),
  }
): Promise<number> {
  const command = args[0];
  if (command === 'taskmaster') {
    const dbPath = flag(args, '--db-path');
    const statusUrl = flag(args, '--status-url');
    const githubRepo = flag(args, '--github-repo');
    const outputRoot = flag(args, '--output-root');
    const issueValue = flag(args, '--github-issue');
    const intervalValue = flag(args, '--interval-ms') ?? env.TASKMASTER_INTERVAL_MS;
    const githubIssue = issueValue === undefined ? NaN : Number(issueValue);
    const intervalMs = intervalValue === undefined ? undefined : Number(intervalValue);
    if (
      !dbPath ||
      !statusUrl ||
      !githubRepo ||
      !outputRoot ||
      !Number.isSafeInteger(githubIssue) ||
      githubIssue <= 0 ||
      (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs < 0))
    ) {
      deps.stderr('taskmaster_canary_missing_or_invalid_required_argument');
      return 3;
    }
    const report = await (deps.taskmasterRunner ?? runTaskmasterCanarySuite)({
      dbPath,
      statusUrl,
      githubRepo,
      githubIssue,
      intervalMs,
      operatorToken: env.ARCHON_OPERATOR_TOKEN,
    });
    await (deps.taskmasterArtifactWriter ?? writeTaskmasterCanaryArtifacts)(outputRoot, report);
    deps.stdout(JSON.stringify(report, null, 2));
    return exitFor(report.verdict);
  }
  if (command === 'pr-review') {
    const dbPath = flag(args, '--db-path');
    const outputRoot = flag(args, '--output-root');
    const apiBase = flag(args, '--api-base');
    const owner = flag(args, '--owner');
    const repo = flag(args, '--repo');
    const branch = flag(args, '--branch');
    const headSha = flag(args, '--head-sha');
    const prValue = flag(args, '--pr-number');
    const prNumber = prValue === undefined ? undefined : Number(prValue);
    const windowValue = flag(args, '--window');
    const windowHours = windowValue === undefined ? undefined : Number(windowValue);
    if (
      !dbPath ||
      !outputRoot ||
      (prValue !== undefined && (!Number.isSafeInteger(prNumber) || (prNumber ?? 0) <= 0)) ||
      (windowValue !== undefined && (!Number.isFinite(windowHours) || (windowHours ?? 0) <= 0))
    ) {
      deps.stderr('pr_review_canary_missing_or_invalid_required_argument');
      return 3;
    }
    const token = env.ARCHON_OPERATOR_TOKEN;
    const github = tryCreatePrReviewGithub(env);
    const report = await (deps.prReviewRunner ?? runPrReviewCanarySuite)({
      dbPath,
      operatorToken: token,
      statusUrl: apiBase
        ? `${apiBase.replace(/\/$/, '')}/api/overseer/pr-review/status`
        : undefined,
      requestUrl: apiBase
        ? `${apiBase.replace(/\/$/, '')}/api/overseer/pr-review/request`
        : undefined,
      queueUrl: apiBase ? `${apiBase.replace(/\/$/, '')}/api/overseer/pr-review/queue` : undefined,
      owner,
      repo,
      branch,
      headSha,
      prNumber,
      ...(windowHours === undefined ? {} : { ingestLookbackMs: windowHours * 60 * 60 * 1000 }),
      ...(hasFlag(args, '--c3-synthetic-escalation') ? { c3SyntheticEscalation: true } : {}),
      ...(github ? { github } : {}),
    });
    await (deps.prReviewArtifactWriter ?? writePrReviewCanaryArtifacts)(outputRoot, report);
    deps.stdout(JSON.stringify(report, null, 2));
    printBlockedCanaries(report, deps.stderr);
    return exitFor(report.verdict);
  }
  const level = command === 'check' ? 0 : command === 'plan' ? 1 : null;
  if (level === null) {
    deps.stderr(
      'Usage: archon-canary <check|plan|taskmaster|pr-review> [options]\n' +
        'pr-review: --db-path --output-root [--owner --repo --pr-number] [--window hours] [--c3-synthetic-escalation]\n' +
        'blocked reasons: c6_github_client_unavailable, c3_synthetic_escalation_not_enabled, c3_refused_production_store'
    );
    return 3;
  }
  const manifestPath = flag(args, '--manifest');
  const apiBase = flag(args, '--api-base');
  const codebaseId = flag(args, '--codebase-id');
  const outputRoot = flag(args, '--output-root');
  if (!manifestPath || !apiBase || !codebaseId || !outputRoot) {
    deps.stderr('canary_cli_missing_required_argument');
    return 3;
  }
  const tokenFile = flag(args, '--token-file');
  const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : env.ARCHON_OPERATOR_TOKEN;
  if (!token) {
    deps.stderr('ARCHON_OPERATOR_TOKEN is required (or use --token-file)');
    return 3;
  }
  try {
    const result = await deps.runner({
      level,
      manifestPath,
      apiBase,
      token,
      outputRoot,
      codebaseId,
    });
    if (args.includes('--json')) deps.stdout(JSON.stringify(result.report, null, 2));
    else deps.stdout(`${result.report.verdict}: ${result.report.suiteRunId}`);
    return exitFor(result.report.verdict);
  } catch (error) {
    deps.stderr((error as Error).message.replaceAll(token, '[REDACTED]'));
    return 4;
  }
}

if (import.meta.main) process.exitCode = await runCanaryCli(Bun.argv.slice(2));
