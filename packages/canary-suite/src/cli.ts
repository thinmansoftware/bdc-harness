import { readFile } from 'fs/promises';
import { runCanary, type RunCanaryOptions } from './runner';
import type { LifecycleCanaryReport, RunCanaryResult } from './types';
import {
  runTaskmasterCanarySuite,
  writeTaskmasterCanaryArtifacts,
  type TaskmasterCanaryDeps,
  type TaskmasterCanaryResult,
} from './taskmaster-canary';
import {
  createDefaultArtifactSource,
  resolveBaseRevision,
  runLifecycleCanarySuite,
  LIFECYCLE_SCRATCH_DIR,
  type LifecycleCanaryDeps,
  type LifecycleMutationHooks,
} from './lifecycle-canary';
import { writeLifecycleCanaryArtifacts } from './lifecycle-report';

interface CanaryCliDeps {
  readonly runner: (options: RunCanaryOptions) => Promise<RunCanaryResult>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly taskmasterRunner?: (options: TaskmasterCanaryDeps) => Promise<TaskmasterCanaryResult>;
  readonly taskmasterArtifactWriter?: (
    outputRoot: string,
    report: TaskmasterCanaryResult
  ) => Promise<readonly string[]>;
  readonly lifecycleRunner?: (deps: LifecycleCanaryDeps) => Promise<LifecycleCanaryReport>;
  readonly lifecycleArtifactWriter?: (
    outputRoot: string,
    report: LifecycleCanaryReport
  ) => Promise<readonly string[]>;
  // Builds the live LifecycleCanaryDeps (default source + fire hook) from CLI
  // flags. Injected so unit tests never touch the production-adjacent firing
  // path; the operator-approved live phase supplies the real implementation.
  readonly lifecycleDepsFactory?: (options: LifecycleCliOptions) => LifecycleCanaryDeps;
  // Supplies ONLY the mutating hooks (initiate / fireFallback / cleanup). The
  // read-only artifact source and the pre-run residue anchor are wired by
  // default, so an operator enabling a live run supplies just the side effects.
  readonly lifecycleMutationHooks?: (options: LifecycleCliOptions) => LifecycleMutationHooks;
}

export interface LifecycleCliOptions {
  readonly runId: string;
  readonly outputRoot: string;
  readonly dbPath: string;
  readonly githubRepo: string;
  readonly baseBranch: string;
  readonly repoDir: string;
  readonly apiBase?: string;
  readonly codebaseId?: string;
  readonly dutyOfficerReportPath?: string;
  readonly mergeIdentity: string;
  readonly operatorToken?: string;
  // Base-branch revision captured before the run. Resolved from git when unset.
  readonly preRunRevision?: string;
}

// Wires the read-only artifact source plus the pre-run residue anchor around an
// operator-supplied set of mutating hooks.
async function buildDefaultLifecycleDeps(
  options: LifecycleCliOptions,
  hooks: LifecycleMutationHooks
): Promise<LifecycleCanaryDeps> {
  // Captured BEFORE any hook runs: Leg 10 compares the post-run base tip
  // against this revision, so it must predate every canary mutation.
  const preRunRevision =
    options.preRunRevision ?? (await resolveBaseRevision(options.repoDir, options.baseBranch));
  return {
    runId: options.runId,
    githubRepo: options.githubRepo,
    baseBranch: options.baseBranch,
    source: createDefaultArtifactSource({
      dbPath: options.dbPath,
      githubRepo: options.githubRepo,
      repoDir: options.repoDir,
      scratchDir: LIFECYCLE_SCRATCH_DIR,
      dutyOfficerReportPath: options.dutyOfficerReportPath ?? null,
    }),
    preRunRevision,
    initiate: hooks.initiate,
    fireFallback: hooks.fireFallback,
    cleanup: hooks.cleanup,
    runStartIso: new Date().toISOString(),
    mergeIdentity: options.mergeIdentity,
  };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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
  if (command === 'lifecycle') {
    const runId = flag(args, '--run-id');
    const outputRoot = flag(args, '--output-root');
    const dbPath = flag(args, '--db-path');
    const githubRepo = flag(args, '--github-repo');
    const baseBranch = flag(args, '--base-branch') ?? 'dev';
    const repoDir = flag(args, '--repo-dir') ?? process.cwd();
    const mergeIdentity = flag(args, '--merge-identity') ?? 'bluedevilcollectibles';
    if (!runId || !outputRoot || !dbPath || !githubRepo) {
      deps.stderr('lifecycle_canary_missing_or_invalid_required_argument');
      return 3;
    }
    const depsFactory = deps.lifecycleDepsFactory;
    const hooksFactory = deps.lifecycleMutationHooks;
    if (!depsFactory && !hooksFactory) {
      // Read-only artifact access is wired by default, but firing the wheel is
      // production-adjacent (opens a real issue/PR against the base branch and
      // may merge on dev). The default CLI does NOT wire the mutating hooks --
      // the operator-approved live phase must supply them. Fail closed rather
      // than silently no-op.
      deps.stderr(
        'lifecycle_fire_not_configured: the lifecycle canary opens a real issue/PR against ' +
          `origin/${baseBranch}; supply an operator-approved mutation-hook implementation`
      );
      return 3;
    }
    const options: LifecycleCliOptions = {
      runId,
      outputRoot,
      dbPath,
      githubRepo,
      baseBranch,
      repoDir,
      apiBase: flag(args, '--api-base'),
      codebaseId: flag(args, '--codebase-id'),
      dutyOfficerReportPath: flag(args, '--duty-officer-report'),
      mergeIdentity,
      operatorToken: env.ARCHON_OPERATOR_TOKEN,
      preRunRevision: flag(args, '--pre-run-revision'),
    };
    try {
      let lifecycleDeps: LifecycleCanaryDeps;
      if (depsFactory) {
        lifecycleDeps = depsFactory(options);
      } else if (hooksFactory) {
        lifecycleDeps = await buildDefaultLifecycleDeps(options, hooksFactory(options));
      } else {
        // Unreachable: both factories were rejected by the guard above.
        deps.stderr('lifecycle_fire_not_configured');
        return 3;
      }
      const report = await (deps.lifecycleRunner ?? runLifecycleCanarySuite)(lifecycleDeps);
      await (deps.lifecycleArtifactWriter ?? writeLifecycleCanaryArtifacts)(outputRoot, report);
      deps.stdout(JSON.stringify(report, null, 2));
      return exitFor(report.verdict);
    } catch (error) {
      deps.stderr((error as Error).message);
      return 4;
    }
  }
  const level = command === 'check' ? 0 : command === 'plan' ? 1 : null;
  if (level === null) {
    deps.stderr('Usage: archon-canary <check|plan|taskmaster|lifecycle> [options]');
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
