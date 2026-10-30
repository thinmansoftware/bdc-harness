import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { MAX_TRACKED_BYTES, TRACKED_REFRESH_MS } from './constants';
import { ToolFailure } from './errors';

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== 'GIT_DIR' &&
      key !== 'GIT_WORK_TREE' &&
      key !== 'GIT_INDEX_FILE'
    ) {
      env[key] = value;
    }
  }
  return env;
}

async function gitText(
  root: string,
  args: readonly string[]
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnv(),
  });
  const [code, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout };
}

function cloneStatusDirty(stdout: string): boolean {
  for (const entry of stdout.split('\0')) {
    if (entry.length > 0) {
      return true;
    }
  }
  return false;
}

export function lexicalTrackedPath(requested: string, prefix: string): string | null {
  if (requested.length === 0 || requested.length > 512) {
    return null;
  }
  if (requested.startsWith('/') || requested.startsWith('\\') || /^[A-Za-z]:/.test(requested)) {
    return null;
  }
  if (requested.includes('\\') || requested.includes('\0')) {
    return null;
  }
  const parts = requested.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return null;
  }
  if (requested !== prefix && !requested.startsWith(`${prefix}/`)) {
    return null;
  }
  return requested;
}

export class TrackedTree {
  private files = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly root: string,
    private readonly intervalMs: number = TRACKED_REFRESH_MS
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {
        // Dirty and untracked clones clear the served set inside refresh().
        // The next tick retries.
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  has(relativePath: string): boolean {
    return this.files.has(relativePath);
  }

  list(prefix: string): string[] {
    const matches: string[] = [];
    for (const file of this.files) {
      if (file === prefix || file.startsWith(`${prefix}/`)) {
        matches.push(file);
      }
    }
    matches.sort();
    return matches;
  }

  async refresh(): Promise<void> {
    const status = await gitText(this.root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    if (status.code !== 0 || cloneStatusDirty(status.stdout)) {
      this.files = new Set();
      throw new Error(status.code !== 0 ? 'wiki_root_unreadable' : 'wiki_root_dirty');
    }
    const listed = await gitText(this.root, ['ls-files', '-z', '--', 'xo-wiki/wiki', 'docs/board']);
    if (listed.code !== 0) {
      throw new Error('wiki_root_unreadable');
    }
    const next = new Set<string>();
    for (const entry of listed.stdout.split('\0')) {
      if (entry.length > 0) {
        next.add(entry);
      }
    }
    this.files = next;
  }
}

export async function readTrackedFile(root: string, relativePath: string): Promise<string> {
  const rootReal = await realpath(root);
  const absolute = join(rootReal, relativePath);
  const parentReal = await realpath(dirname(absolute));
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new ToolFailure('refused', 'path_refused');
  }
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ToolFailure('refused', 'path_refused');
  }
  if (info.size > MAX_TRACKED_BYTES) {
    throw new ToolFailure('refused', 'path_refused');
  }
  return readFile(absolute, 'utf8');
}
