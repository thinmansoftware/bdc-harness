import { createHash } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { spawn } from 'bun';

export const CURSOR_GROK_MODEL = 'cursor-grok-4.5-high' as const;

export interface RunWorkArtifact {
  path: string;
  sha256: string;
  content_base64: string;
  size_bytes: number;
}

export interface RunWorkRequest {
  version: 'v1';
  correlation_id: string;
  idempotency_key: string;
  workflow_run_id: string;
  node_id: string;
  provider_attempt_id: string;
  provider_attempt_number: number;
  execution_mode: 'read_only' | 'repository_write';
  repository: { remote_url: string; branch: string; requested_sha: string };
  model: typeof CURSOR_GROK_MODEL;
  prompt: string;
  artifacts: {
    source_root: string;
    inputs: RunWorkArtifact[];
    outputs: string[];
    max_file_bytes: number;
    max_total_bytes: number;
  };
}

export interface RunWorkResult {
  version: 'v1';
  worker_id: string;
  fencing_token: number;
  outcome: 'succeeded' | 'failed' | 'timed_out' | 'blocked';
  requested_sha: string;
  resulting_sha: string | null;
  output: string;
  model: typeof CURSOR_GROK_MODEL;
  artifacts: { outputs: RunWorkArtifact[] };
}

export interface RunWorkConfig {
  enabled: boolean;
  cursor_binary: string;
  repository_allowlist: string[];
  worktree_root: string;
  wall_clock_ms: number;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; stdin?: string; timeoutMs?: number; isCancelled?: () => boolean }
) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
}>;

export interface RunWorkDependencies {
  runCommand?: CommandRunner;
  isCancelled?: () => boolean;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertSafeRelativePath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`run_work_unsafe_artifact_path:${path}`);
  }
}

function assertWithin(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('run_work_path_escaped_root');
  }
}

export function parseRunWorkRequest(body: string, config: RunWorkConfig): RunWorkRequest {
  const request = JSON.parse(body) as RunWorkRequest;
  if (
    request?.version !== 'v1' ||
    request.model !== CURSOR_GROK_MODEL ||
    !['read_only', 'repository_write'].includes(request.execution_mode) ||
    !/^[0-9a-f]{40}$/i.test(request.repository?.requested_sha ?? '') ||
    !request.repository?.branch ||
    /^(main|master|dev|staging|production|release(?:\/.*)?)$/i.test(request.repository.branch) ||
    !config.repository_allowlist.includes(request.repository?.remote_url) ||
    !Array.isArray(request.artifacts?.inputs) ||
    !Array.isArray(request.artifacts?.outputs)
  ) {
    throw new Error('run_work_request_rejected');
  }
  const outputSet = new Set<string>();
  let total = 0;
  for (const path of request.artifacts.outputs) {
    assertSafeRelativePath(path);
    if (outputSet.has(path)) throw new Error('run_work_duplicate_output_path');
    outputSet.add(path);
  }
  for (const artifact of request.artifacts.inputs) {
    assertSafeRelativePath(artifact.path);
    const content = Buffer.from(artifact.content_base64, 'base64');
    total += content.length;
    if (
      content.toString('base64') !== artifact.content_base64 ||
      content.length !== artifact.size_bytes ||
      sha256(content) !== artifact.sha256 ||
      content.length > request.artifacts.max_file_bytes ||
      total > request.artifacts.max_total_bytes
    ) {
      throw new Error('run_work_input_artifact_rejected');
    }
  }
  return request;
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd: string; stdin?: string; timeoutMs?: number; isCancelled?: () => boolean }
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}> {
  const proc = spawn({
    cmd: [command, ...args],
    cwd: options.cwd,
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (options.stdin !== undefined) {
    if (!proc.stdin) throw new Error('run_work_stdin_unavailable');
    proc.stdin.write(options.stdin);
    await proc.stdin.end();
  }
  let timedOut = false;
  let cancelled = false;
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, options.timeoutMs)
    : undefined;
  timeout?.unref?.();
  const cancelTimer = options.isCancelled
    ? setInterval(() => {
        if (options.isCancelled?.()) {
          cancelled = true;
          proc.kill();
        }
      }, 100)
    : undefined;
  cancelTimer?.unref?.();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (cancelTimer) clearInterval(cancelTimer);
  });
  return { exitCode, stdout, stderr, timedOut, cancelled };
}

async function requireCommandSuccess(
  runCommand: CommandRunner,
  command: string,
  args: string[],
  cwd: string
): Promise<string> {
  const result = await runCommand(command, args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`run_work_command_failed:${command}:${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function executeRunWork(
  request: RunWorkRequest,
  config: RunWorkConfig,
  identity: { worker_id: string; fencing_token: number },
  dependencies: RunWorkDependencies = {}
): Promise<RunWorkResult> {
  if (!config.enabled) throw new Error('run_work_disabled');
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const worktreeRoot = resolve(config.worktree_root);
  await mkdir(worktreeRoot, { recursive: true });
  const taskRoot = await mkdtemp(join(worktreeRoot, 'run-work-'));
  assertWithin(worktreeRoot, taskRoot);
  const repoDir = join(taskRoot, 'repo');
  const artifactDir = join(taskRoot, 'artifacts');
  try {
    await mkdir(artifactDir, { recursive: true });
    for (const artifact of request.artifacts.inputs) {
      const destination = resolve(artifactDir, artifact.path);
      assertWithin(artifactDir, destination);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(artifact.content_base64, 'base64'), { flag: 'wx' });
    }

    await requireCommandSuccess(
      runCommand,
      'git',
      [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        '--',
        request.repository.remote_url,
        repoDir,
      ],
      taskRoot
    );
    await requireCommandSuccess(
      runCommand,
      'git',
      ['fetch', '--no-tags', 'origin', request.repository.requested_sha],
      repoDir
    );
    await requireCommandSuccess(
      runCommand,
      'git',
      ['checkout', '-B', request.repository.branch, request.repository.requested_sha],
      repoDir
    );

    const localPrompt = request.prompt
      .split(request.artifacts.source_root)
      .join(artifactDir.replace(/\\/g, '/'));
    const cursorArgs = [
      '--print',
      '--output-format',
      'text',
      '--model',
      CURSOR_GROK_MODEL,
      '--workspace',
      repoDir,
      '--trust',
      ...(request.execution_mode === 'read_only' ? ['--mode', 'plan'] : ['--force']),
    ];
    const cursor = await runCommand(config.cursor_binary, cursorArgs, {
      cwd: repoDir,
      stdin: localPrompt,
      timeoutMs: config.wall_clock_ms,
      isCancelled: dependencies.isCancelled,
    });
    if (cursor.exitCode !== 0) {
      return {
        version: 'v1',
        ...identity,
        outcome: cursor.timedOut ? 'timed_out' : 'failed',
        requested_sha: request.repository.requested_sha,
        resulting_sha: null,
        output: cursor.stderr.trim() || cursor.stdout.trim() || 'Cursor Desktop execution failed.',
        model: CURSOR_GROK_MODEL,
        artifacts: { outputs: [] },
      };
    }

    const resultingSha = await requireCommandSuccess(
      runCommand,
      'git',
      ['rev-parse', 'HEAD'],
      repoDir
    );
    const status = await requireCommandSuccess(
      runCommand,
      'git',
      ['status', '--porcelain'],
      repoDir
    );
    if (status) throw new Error('run_work_left_uncommitted_changes');
    if (request.execution_mode === 'read_only') {
      if (resultingSha !== request.repository.requested_sha) {
        throw new Error('run_work_read_only_sha_changed');
      }
    } else {
      if (resultingSha === request.repository.requested_sha) {
        throw new Error('run_work_write_missing_commit');
      }
      await requireCommandSuccess(
        runCommand,
        'git',
        ['merge-base', '--is-ancestor', request.repository.requested_sha, resultingSha],
        repoDir
      );
      await requireCommandSuccess(
        runCommand,
        'git',
        [
          'push',
          `--force-with-lease=${request.repository.branch}:${request.repository.requested_sha}`,
          'origin',
          `HEAD:refs/heads/${request.repository.branch}`,
        ],
        repoDir
      );
    }

    const outputs: RunWorkArtifact[] = [];
    let total = 0;
    for (const path of request.artifacts.outputs) {
      const source = resolve(artifactDir, path);
      assertWithin(artifactDir, source);
      const content = await readFile(source);
      total += content.length;
      if (
        content.length > request.artifacts.max_file_bytes ||
        total > request.artifacts.max_total_bytes
      ) {
        throw new Error('run_work_output_artifact_exceeds_limit');
      }
      outputs.push({
        path,
        sha256: sha256(content),
        content_base64: content.toString('base64'),
        size_bytes: content.length,
      });
    }
    return {
      version: 'v1',
      ...identity,
      outcome: 'succeeded',
      requested_sha: request.repository.requested_sha,
      resulting_sha: resultingSha,
      output: cursor.stdout.trim(),
      model: CURSOR_GROK_MODEL,
      artifacts: { outputs },
    };
  } finally {
    assertWithin(worktreeRoot, taskRoot);
    await rm(taskRoot, { recursive: true, force: true });
  }
}
