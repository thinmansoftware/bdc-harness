/**
 * Build scripts/served-lanes/history.json from committed blob hashes.
 *
 * For each top-level .archon/workflows/defaults/*.yaml, record the sha256 of
 * every added or modified ancestor blob, including a version that survived
 * only on one side of a merge. Output is sorted, one hash per line, so a
 * merge conflict stays trivial to resolve. The renderer is written as-is:
 * Prettier's JSON printer collapses a one-hash list onto a single line.
 *
 *   bun run scripts/served-lanes/generate-history.ts
 *   bun run scripts/served-lanes/generate-history.ts --check
 *
 * Exit codes:
 *   0  written, or --check found the committed manifest current
 *   1  unexpected error
 *   2  --check found the committed manifest stale or missing
 */
import { createHash } from 'crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const DEFAULTS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const OUTPUT_PATH = join(import.meta.dir, 'history.json');
const GIT_POOL = 16;

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface GitFailure extends Error {
  code?: number | string;
  stdout?: Buffer;
  stderr?: Buffer;
}

function runGit(
  args: readonly string[],
  repoRoot: string = REPO_ROOT
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolveGit, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        const out = stdout as unknown as Buffer;
        const errBuf = stderr as unknown as Buffer;
        if (error) {
          const failure = error as GitFailure;
          failure.stdout = out;
          failure.stderr = errBuf;
          reject(failure);
          return;
        }
        resolveGit({ stdout: out, stderr: errBuf });
      }
    );
  });
}

function isMissingBlob(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as GitFailure;
  const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : '';
  const missing =
    stderr.includes('does not exist') || stderr.includes('exists on disk, but not in');
  if (!missing) return false;
  return failure.code === 128 || stderr.includes('fatal:');
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) {
        throw new Error(`missing history work item at ${String(index)}`);
      }
      results[index] = await fn(item);
    }
  }
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(limit, items.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

export async function committedBlobHashes(
  relativePath: string,
  head: string,
  repoRoot: string = REPO_ROOT
): Promise<string[]> {
  // Default path-limited log prunes a merge parent whose blob did not win.
  // --full-history walks every parent so each committed ancestor version
  // still contributes its sha256.
  const log = await runGit(
    [
      '--no-pager',
      'log',
      '--full-history',
      '--format=%H',
      '--diff-filter=AM',
      head,
      '--',
      relativePath,
    ],
    repoRoot
  );
  const revisions = new Set(
    log.stdout
      .toString('utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
  );
  revisions.add(head);
  const hashes = new Set<string>();
  for (const revision of revisions) {
    try {
      const blob = await runGit(['--no-pager', 'show', `${revision}:${relativePath}`], repoRoot);
      hashes.add(sha256Hex(blob.stdout));
    } catch (error) {
      if (isMissingBlob(error)) continue;
      throw error;
    }
  }
  return [...hashes].sort(compareAscii);
}

export function renderHistoryJson(history: Readonly<Record<string, readonly string[]>>): string {
  const keys = Object.keys(history).sort(compareAscii);
  if (keys.length === 0) return '{}\n';
  const lines: string[] = ['{'];
  keys.forEach((key, index) => {
    const hashes = history[key] ?? [];
    const comma = index === keys.length - 1 ? '' : ',';
    if (hashes.length === 0) {
      lines.push(`  ${JSON.stringify(key)}: []${comma}`);
      return;
    }
    lines.push(`  ${JSON.stringify(key)}: [`);
    hashes.forEach((hash, hashIndex) => {
      const hashComma = hashIndex === hashes.length - 1 ? '' : ',';
      lines.push(`    ${JSON.stringify(hash)}${hashComma}`);
    });
    lines.push(`  ]${comma}`);
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export async function renderHistory(): Promise<string> {
  const entries = await readdir(DEFAULTS_DIR, { withFileTypes: true });
  const filenames = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
    .map(entry => entry.name)
    .sort(compareAscii);
  const headResult = await runGit(['--no-pager', 'rev-parse', 'HEAD']);
  const head = headResult.stdout.toString('utf8').trim();
  const hashLists = await mapPool(filenames, GIT_POOL, filename =>
    committedBlobHashes(join('.archon/workflows/defaults', filename), head)
  );
  const history: Record<string, readonly string[]> = {};
  filenames.forEach((filename, index) => {
    history[filename] = hashLists[index] ?? [];
  });
  return renderHistoryJson(history);
}

async function main(): Promise<void> {
  const rendered = await renderHistory();
  if (!process.argv.includes('--check')) {
    await writeFile(OUTPUT_PATH, rendered);
    return;
  }
  let current: string;
  try {
    current = await readFile(OUTPUT_PATH, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      console.error(`served lane history is missing: ${OUTPUT_PATH}`);
      process.exit(2);
    }
    throw error;
  }
  if (current !== rendered) {
    console.error(
      'served lane history is stale; regenerate with bun run scripts/served-lanes/generate-history.ts'
    );
    process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
