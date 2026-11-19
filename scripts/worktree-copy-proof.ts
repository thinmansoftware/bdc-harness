/**
 * Live proof for WO-HARNESS-WORKTREE-SYNC-NO-TRACKED-OVERWRITE-01.
 *
 * Builds two throwaway git repositories under the OS temp directory: a canonical source checkout
 * with an OLD tracked `.archon/workflows/a.yaml` and a local-only untracked `.archon/config.yaml`,
 * and a worktree whose tracked `a.yaml` holds the NEW text. It runs the real copy
 * (`copyWorktreeFiles` from @archon/isolation) and prints one line:
 *
 *   WORKTREE_COPY_PROOF tracked_overwritten=<n> untracked_copied=<n>
 *
 * Exit 0 only when tracked_overwritten is 0 and untracked_copied is 1. Run inside the container:
 *   docker exec archon-app-1 bun run /app/scripts/worktree-copy-proof.ts
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { copyWorktreeFiles } from '../packages/isolation/src/worktree-copy';

const NEW = 'text: new staging wording\n';
const OLD = 'text: old master wording\n';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(base: string, rel: string, content: string): void {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const root = mkdtempSync(join(tmpdir(), 'worktree-copy-proof-'));
let code = 1;
try {
  const canonical = join(root, 'canonical');
  const worktree = join(root, 'worktree');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(worktree, { recursive: true });

  git(worktree, 'init', '-q');
  git(worktree, 'config', 'user.email', 'proof@example.invalid');
  git(worktree, 'config', 'user.name', 'proof');
  git(worktree, 'config', 'core.autocrlf', 'false');
  write(worktree, '.archon/workflows/a.yaml', NEW);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'base');

  write(canonical, '.archon/workflows/a.yaml', OLD);
  write(canonical, '.archon/config.yaml', 'local: only\n');

  await copyWorktreeFiles(canonical, worktree, ['.archon']);

  const trackedOverwritten =
    readFileSync(join(worktree, '.archon/workflows/a.yaml'), 'utf8') === NEW ? 0 : 1;
  let untrackedCopied = 0;
  try {
    untrackedCopied =
      readFileSync(join(worktree, '.archon/config.yaml'), 'utf8') === 'local: only\n' ? 1 : 0;
  } catch {
    untrackedCopied = 0;
  }
  console.log(
    `WORKTREE_COPY_PROOF tracked_overwritten=${trackedOverwritten} untracked_copied=${untrackedCopied}`
  );
  code = trackedOverwritten === 0 && untrackedCopied === 1 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
