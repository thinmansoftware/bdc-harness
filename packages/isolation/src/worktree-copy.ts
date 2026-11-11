/**
 * Worktree file copy utility
 *
 * Copies git-ignored files from the canonical repo to a new worktree
 * based on configuration in .archon/config.yaml
 */

import { copyFile, cp, lstat, stat, mkdir, readdir } from 'fs/promises';
import { join, dirname, relative, isAbsolute, normalize } from 'path';
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('worktree-copy');
  return cachedLog;
}

export interface CopyFileEntry {
  source: string;
  destination: string;
}

/**
 * Parse a copy file entry from config.
 * Each entry is a path to a git-ignored file or directory to copy into worktrees.
 *
 * @param entry - Config entry like ".env" or "data/fixtures/"
 * @returns Parsed source and destination (always identical)
 * @throws Error if entry is empty
 */
export function parseCopyFileEntry(entry: string): CopyFileEntry {
  const trimmed = entry.trim();

  if (!trimmed) {
    throw new Error('Copy entry cannot be empty');
  }

  return { source: trimmed, destination: trimmed };
}

/**
 * Check if a path escapes its root directory (path traversal attack)
 * Works on both Unix and Windows paths
 *
 * @param root - The root directory path
 * @param filePath - The relative file path to check
 * @returns true if path stays within root, false if it escapes
 */
export function isPathWithinRoot(root: string, filePath: string): boolean {
  // Join and normalize to resolve any ../ segments
  const fullPath = normalize(join(root, filePath));
  const normalizedRoot = normalize(root);

  // Get relative path from root to fullPath
  const relativePath = relative(normalizedRoot, fullPath);

  // If relative path starts with '..' or is absolute, it escapes the root
  // On Windows, cross-drive paths will be absolute (e.g., "D:\other")
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return false;
  }

  return true;
}

/** Forward-slash form of a path, as git prints it. */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Paths under `relPath` that git tracks in the destination worktree (forward slashes, relative
 * to `destRoot`). A tracked path keeps the worktree's own content: the canonical repo may be on a
 * different branch with an older copy, and overwriting would dirty the worktree (the run-scope
 * gate then fails) and let a later `git add -A` commit the older text (bdc-xo WO
 * WO-HARNESS-WORKTREE-SYNC-NO-TRACKED-OVERWRITE-01). Returns an empty set when `destRoot` is not a
 * git checkout or git cannot list it, so the copy then behaves exactly as before.
 */
async function listTrackedPaths(destRoot: string, relPath: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', destRoot, 'ls-files', '-z', '--', relPath || '.'],
      { timeout: 15000, maxBuffer: 64 * 1024 * 1024 }
    );
    return new Set(stdout.split('\0').filter(entry => entry.length > 0));
  } catch {
    return new Set();
  }
}

/** True when anything (including a dangling link) exists at `path`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `path` is a symbolic link. A missing path is not one. Any other error counts as one
 * (fail safe: the copy skips the path).
 */
async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * True when `destPath`, or any directory between `destRoot` and it, is a symbolic link: writing
 * there would follow the link and could overwrite a tracked file outside the copied folder (the
 * worktree may track `.archon/workflows` as a symlink to another directory).
 */
async function destinationTraversesSymlink(destRoot: string, destPath: string): Promise<boolean> {
  const segments = relative(destRoot, destPath)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = destRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (await isSymbolicLink(current)) return true;
    try {
      await lstat(current);
    } catch {
      return false; // the rest of the path does not exist yet, so there is nothing to follow
    }
  }
  return false;
}

/**
 * Copy a directory file by file, leaving every path in `tracked` untouched and never following a
 * destination symbolic link.
 *
 * @returns the number of tracked paths skipped
 */
async function copyDirectorySkippingTracked(
  sourceDir: string,
  destDir: string,
  destRoot: string,
  tracked: ReadonlySet<string>
): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let skipped = 0;
  for (const dirent of await readdir(sourceDir, { withFileTypes: true })) {
    const sourceEntry = join(sourceDir, dirent.name);
    const destEntry = join(destDir, dirent.name);
    if (tracked.has(toPosix(relative(destRoot, destEntry))) || (await isSymbolicLink(destEntry))) {
      // tracked in the worktree (a file, or a directory the worktree tracks as a link), or a link
      skipped += 1;
    } else if (dirent.isDirectory()) {
      skipped += await copyDirectorySkippingTracked(sourceEntry, destEntry, destRoot, tracked);
    } else {
      await cp(sourceEntry, destEntry);
    }
  }
  return skipped;
}

/**
 * Copy a single file or directory from source repo to worktree
 *
 * A path that git tracks in the destination worktree is never overwritten; untracked,
 * ignored and missing destination paths are copied as before.
 *
 * @param sourceRoot - Canonical repo path
 * @param destRoot - Worktree path
 * @param entry - Parsed copy file entry
 * @returns true if copied successfully, false if:
 *   - Source doesn't exist (ENOENT) - expected, silently skipped
 *   - Path traversal detected - security violation, logged as error
 *   - Other errors (permissions, disk full, etc.) - logged as error
 */
export async function copyWorktreeFile(
  sourceRoot: string,
  destRoot: string,
  entry: CopyFileEntry
): Promise<boolean> {
  // Security: Validate paths don't escape their roots (prevents path traversal)
  if (!isPathWithinRoot(sourceRoot, entry.source)) {
    getLog().error(
      { source: entry.source, sourceRoot, reason: 'Source path escapes repository root' },
      'path_traversal_blocked'
    );
    return false;
  }

  if (!isPathWithinRoot(destRoot, entry.destination)) {
    getLog().error(
      {
        destination: entry.destination,
        destRoot,
        reason: 'Destination path escapes worktree root',
      },
      'path_traversal_blocked'
    );
    return false;
  }

  const sourcePath = join(sourceRoot, entry.source);
  const destPath = join(destRoot, entry.destination);

  try {
    const stats = await stat(sourcePath);

    // Ensure destination directory exists
    await mkdir(dirname(destPath), { recursive: true });

    const destRelative = toPosix(relative(destRoot, destPath));
    let skippedTracked = 0;
    if (await destinationTraversesSymlink(destRoot, destPath)) {
      getLog().info(
        { source: entry.source, destination: entry.destination },
        'file_copy_skipped_symlink'
      );
      return true;
    }
    const tracked = await listTrackedPaths(destRoot, destRelative);

    if (stats.isDirectory()) {
      if (!(await pathExists(destPath))) {
        // Nothing exists at the destination yet: nothing to overwrite and no link to follow, so the
        // plain recursive copy is safe. Any existing destination is walked entry by entry.
        await cp(sourcePath, destPath, { recursive: true });
      } else {
        skippedTracked = await copyDirectorySkippingTracked(
          sourcePath,
          destPath,
          destRoot,
          tracked
        );
      }
    } else if (tracked.has(destRelative)) {
      skippedTracked = 1;
    } else {
      // Copy single file
      await copyFile(sourcePath, destPath);
    }

    if (skippedTracked > 0) {
      getLog().info(
        { source: entry.source, destination: entry.destination, skippedTracked },
        'file_copy_skipped_tracked'
      );
    }
    getLog().debug({ source: entry.source, destination: entry.destination }, 'file_copied');
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err.code === 'ENOENT') {
      // Source doesn't exist - expected case, skip silently
      // This matches worktree-manager skill behavior
      getLog().debug({ source: entry.source }, 'file_skipped_not_found');
      return false;
    }

    // Unexpected error - log with full context for debugging
    getLog().error(
      {
        source: entry.source,
        destination: entry.destination,
        sourcePath,
        destPath,
        err,
        code: err.code ?? 'UNKNOWN',
      },
      'copy_failed'
    );
    return false;
  }
}

/**
 * Copy all configured files from canonical repo to worktree
 *
 * @param canonicalRepoPath - Path to the main repository
 * @param worktreePath - Path to the new worktree
 * @param copyFiles - Array of file paths from config
 * @returns Array of successfully copied entries
 */
export async function copyWorktreeFiles(
  canonicalRepoPath: string,
  worktreePath: string,
  copyFiles: string[]
): Promise<CopyFileEntry[]> {
  const copied: CopyFileEntry[] = [];

  for (const fileConfig of copyFiles) {
    try {
      const entry = parseCopyFileEntry(fileConfig);
      const success = await copyWorktreeFile(canonicalRepoPath, worktreePath, entry);
      if (success) {
        copied.push(entry);
      }
    } catch (parseError) {
      // Invalid config entry - log and continue with other entries
      const err = parseError as Error;
      getLog().error({ entry: fileConfig, err }, 'invalid_config_entry');
    }
  }

  return copied;
}
