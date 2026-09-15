/**
 * Shared judge transport: WHICH executable a ladder rung maps to and HOW the
 * prompt reaches it (#852).
 *
 * Three seams spawn ladder binaries -- the PR-review judge
 * (pr-review-evaluator.ts), the terminal-run judge (judge-first.ts) and the
 * merge second-opinion judge (judge-second-opinion.ts). Until #852 only the
 * first knew the per-binary shape; the other two carried a copy that was wrong
 * twice over: `cursor` was spawned as a literal executable (no such binary in
 * the container -- the CLI is `cursor-agent`, and it has no -p flag), and the
 * whole prompt rode in ONE argv element. Linux caps a single argument at
 * MAX_ARG_STRLEN (131,072 bytes; verified in archon-app-1 alongside ARG_MAX
 * 2,097,152), which is the E2BIG that #776/#786 already fixed for PR review.
 * Live 2026-09-15 13:47Z with OVERSEER_JUDGE_LADDER=codex,grok,cursor, codex
 * out of quota and grok out of credits: the PR-review judge returned a real
 * verdict from the cursor rung while judge-first logged `Executable not found
 * in $PATH: "cursor"` and every terminal run ended judge_unavailable.
 *
 * The prompt is NEVER an argv element. Per binary:
 *
 * - `codex`: `bunx @openai/codex exec --skip-git-repo-check`, prompt on stdin.
 *   With no positional PROMPT, "instructions are read from stdin" (`codex exec
 *   --help`, verified in the container 2026-09-07; matches the board skill's
 *   2026-07-26 finding). 'codex' is not a container binary; the CLI runs via
 *   bunx with the mounted /root/.codex/auth.json.
 * - `cursor`: `cursor-agent --print --mode ask --trust --model <MODEL>`, prompt
 *   on stdin. `--print` with no inline prompt argument reads stdin (this tree's
 *   own record: scripts/dispatch-worker/adapters.ts, promptDelivery 'stdin' --
 *   "claude -p, codex exec, cursor-agent --print"). cursor-agent has no
 *   --prompt-file flag anywhere in this tree, so stdin is the only argv-free
 *   transport. `--mode ask` is READ-ONLY (both `ask` and `plan` are; see
 *   adapters.ts `cursor-build`), which is exactly right for a judge. The model
 *   is selected per call from OVERSEER_CURSOR_JUDGE_MODEL.
 * - anything else (`grok` today): `<binary> --prompt-file <PATH>` -- "Single-turn
 *   prompt from a file" (`grok --help`, verified in the container 2026-09-07).
 *   PATH is a 0600 file inside a private 0700 mkdtemp directory, a short
 *   argument. `-p/--single` takes the prompt inline and is exactly what must be
 *   avoided.
 *
 * Callers own their own timeout race and output handling. Both stdin-fed
 * binaries read stdin to EOF BEFORE they answer, so a caller must start
 * deliverStdin WITHOUT awaiting it, arm its wall clock first, and call
 * destroyStdin when the clock fires and again after the race settles. See
 * runReviewModelProcess in pr-review-evaluator.ts for the incident behind that
 * ordering: a child that never reads stdin back-pressures the write past the
 * ~64 KB pipe buffer and parks it forever.
 */
import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface JudgeTransport {
  argv: string[];
  /** Written to the child's stdin when set. */
  stdinPrompt?: string;
  /** Temp file holding the prompt; removed after the process settles. */
  promptFile?: string;
  /** Private 0700 directory containing `promptFile`; removed with it. */
  promptDir?: string;
}

/** Owner-only directory (rwx------). */
const PROMPT_DIR_MODE = 0o700;
/** Owner-only file (rw-------). */
const PROMPT_FILE_MODE = 0o600;

/**
 * Write the prompt to a file only the running user can read.
 *
 * Review finding (Overseer, PR #790): the prompt embeds the FULL private diff
 * (PR review) or the evidence envelope (judge-first). Writing it straight into
 * the shared system temp directory with default permissions leaves it
 * world-readable under a typical 022 umask, exposing repository contents to
 * any other local user or process for as long as the judge runs.
 *
 * `mkdtemp` creates the directory atomically and exclusively -- no
 * predictable-name race, and no pre-existing path can be hijacked. The mode is
 * then set explicitly rather than trusted to the umask, and the file is written
 * before its mode is tightened, so the window is inside a 0700 directory the
 * whole time.
 */
async function writePrivatePromptFile(
  prompt: string
): Promise<{ promptFile: string; promptDir: string }> {
  const promptDir = await mkdtemp(join(tmpdir(), 'overseer-review-'));
  await chmod(promptDir, PROMPT_DIR_MODE);
  const promptFile = join(promptDir, 'prompt.txt');
  await writeFile(promptFile, prompt, { mode: PROMPT_FILE_MODE });
  await chmod(promptFile, PROMPT_FILE_MODE);
  return { promptFile, promptDir };
}

/**
 * Default model for the `cursor` judge rung. One of the ids returned by
 * `cursor-agent --list-models` on the operator account (verified live
 * 2026-09-15). Override with OVERSEER_CURSOR_JUDGE_MODEL; a blank value falls
 * back to the default rather than producing `--model ''`.
 */
export const DEFAULT_CURSOR_JUDGE_MODEL = 'claude-fable-5-1-thinking-high';

export function resolveCursorJudgeModel(
  env: Record<string, string | undefined> = process.env
): string {
  const configured = env.OVERSEER_CURSOR_JUDGE_MODEL;
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_CURSOR_JUDGE_MODEL;
}

/** argv plus prompt delivery for one ladder rung. The prompt is never in argv. */
export async function buildJudgeTransport(binary: string, prompt: string): Promise<JudgeTransport> {
  if (binary === 'codex') {
    return {
      argv: ['bunx', '@openai/codex', 'exec', '--skip-git-repo-check'],
      stdinPrompt: prompt,
    };
  }
  if (binary === 'cursor') {
    // Read-only ask mode on the Cursor rail; prompt on stdin, never in argv.
    return {
      argv: [
        'cursor-agent',
        '--print',
        '--mode',
        'ask',
        '--trust',
        '--model',
        resolveCursorJudgeModel(),
      ],
      stdinPrompt: prompt,
    };
  }
  const { promptFile, promptDir } = await writePrivatePromptFile(prompt);
  return { argv: [binary, '--prompt-file', promptFile], promptFile, promptDir };
}

/**
 * Remove the prompt file and its private directory. Call from a `finally`:
 * the prompt holds a private diff or evidence envelope, so it must not outlive
 * the judge process on any path -- success, throw, or timeout. Best effort by
 * design: a leaked temp prompt is far less bad than a throw that would
 * reclassify a successful judgment as a transport failure.
 */
export async function removeJudgeTransportFiles(transport: JudgeTransport): Promise<void> {
  if (transport.promptFile) {
    try {
      await unlink(transport.promptFile);
    } catch {
      // Best effort -- see above.
    }
  }
  if (transport.promptDir) {
    try {
      await rm(transport.promptDir, { recursive: true, force: true });
    } catch {
      // Same rationale: cleanup never changes the judgment's outcome.
    }
  }
}

/**
 * The subset of a spawned child the judge seams use. Declared so a test can
 * supply a double -- notably one that never READS stdin, which is the only way
 * to exercise the pipe back-pressure path deterministically.
 */
export interface JudgeChild {
  stdin: unknown;
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  exited: Promise<number>;
  kill(): void;
}

export type JudgeChildSpawn = (argv: string[], stdinMode: 'ignore' | 'pipe') => JudgeChild;

export const defaultJudgeChildSpawn: JudgeChildSpawn = (argv, stdinMode) =>
  Bun.spawn(argv, {
    stdin: stdinMode,
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as JudgeChild;

/**
 * Write the prompt to the child and close the pipe so it sees EOF.
 *
 * Rejections are swallowed on purpose. Once the child is gone -- killed by the
 * timeout, or exited early having read only part of the prompt -- the pending
 * write fails with EPIPE/ERR_STREAM_DESTROYED. That is expected, is not a
 * judgment failure, and must not surface as an unhandled rejection (which
 * crashes the worker under Bun's default handler).
 */
export async function deliverStdin(stdin: unknown, prompt: string): Promise<void> {
  const writer = stdin as {
    write(chunk: string): unknown;
    end(): unknown;
  } | null;
  if (!writer) return;
  try {
    await writer.write(prompt);
    await writer.end();
  } catch {
    // Child gone or pipe torn down -- see above.
  }
}

/**
 * Force the stdin pipe closed so any write parked on back-pressure settles.
 *
 * Killing the child is not sufficient on its own: the awaiting write stays
 * pending until the writer itself is torn down. Every method is attempted
 * defensively because the concrete stdin object differs between Bun's
 * FileSink and a test double, and cleanup must never throw into the result path.
 */
export function destroyStdin(stdin: unknown): void {
  const writer = stdin as {
    destroy?: () => unknown;
    end?: () => unknown;
    close?: () => unknown;
  } | null;
  if (!writer) return;
  for (const method of ['destroy', 'end', 'close'] as const) {
    try {
      writer[method]?.();
    } catch {
      // Best effort: teardown never changes the judgment's outcome.
    }
  }
}
