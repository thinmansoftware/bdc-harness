import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname } from 'path';

import {
  parseCopyFileEntry,
  copyWorktreeFile,
  copyWorktreeFiles,
  isPathWithinRoot,
  type CopyFileEntry,
} from '@archon/isolation';

describe('worktree-copy', () => {
  describe('parseCopyFileEntry', () => {
    test('parses simple filename', () => {
      const result = parseCopyFileEntry('.env');
      expect(result).toEqual({ source: '.env', destination: '.env' });
    });

    test('trims whitespace', () => {
      const result = parseCopyFileEntry('  .env  ');
      expect(result).toEqual({ source: '.env', destination: '.env' });
    });

    test('handles directory paths', () => {
      const result = parseCopyFileEntry('data/fixtures/');
      expect(result).toEqual({ source: 'data/fixtures/', destination: 'data/fixtures/' });
    });

    test('handles nested paths', () => {
      const result = parseCopyFileEntry('.vscode/settings.json');
      expect(result).toEqual({
        source: '.vscode/settings.json',
        destination: '.vscode/settings.json',
      });
    });

    test('treats arrow literally (no rename syntax)', () => {
      const result = parseCopyFileEntry('file-with->arrow.txt');
      expect(result).toEqual({
        source: 'file-with->arrow.txt',
        destination: 'file-with->arrow.txt',
      });
    });

    test('throws on empty string', () => {
      expect(() => parseCopyFileEntry('')).toThrow('Copy entry cannot be empty');
    });

    test('throws on whitespace-only string', () => {
      expect(() => parseCopyFileEntry('   ')).toThrow('Copy entry cannot be empty');
    });
  });

  describe('isPathWithinRoot', () => {
    // Unix-style paths
    test('returns true for simple file in root', () => {
      expect(isPathWithinRoot('/repo', '.env')).toBe(true);
    });

    test('returns true for nested path', () => {
      expect(isPathWithinRoot('/repo', 'src/config/.env')).toBe(true);
    });

    test('returns false for path traversal with ../', () => {
      expect(isPathWithinRoot('/repo', '../other/.env')).toBe(false);
    });

    test('returns false for deep path traversal', () => {
      expect(isPathWithinRoot('/repo', '../../etc/passwd')).toBe(false);
    });

    test('returns false for traversal hidden in nested path', () => {
      expect(isPathWithinRoot('/repo', 'src/../../../etc/passwd')).toBe(false);
    });

    test('returns true for ../ that stays within root', () => {
      expect(isPathWithinRoot('/repo', 'src/../config/.env')).toBe(true);
    });

    test('returns true for absolute root path', () => {
      expect(isPathWithinRoot('/home/user/repo', 'data/file.txt')).toBe(true);
    });

    // Windows-style paths (these work on all platforms due to normalize)
    test('handles Windows-style backslashes in file path', () => {
      expect(isPathWithinRoot('/repo', 'src\\config\\.env')).toBe(true);
    });

    test('blocks Windows-style path traversal', () => {
      expect(isPathWithinRoot('/repo', '..\\other\\.env')).toBe(false);
    });

    // Edge cases
    test('returns true for empty relative path (root itself)', () => {
      expect(isPathWithinRoot('/repo', '')).toBe(true);
    });

    test('returns true for dot (current directory)', () => {
      expect(isPathWithinRoot('/repo', '.')).toBe(true);
    });

    test('returns false for absolute file path', () => {
      // On Unix, this creates /repo//etc/passwd which normalizes to /repo/etc/passwd
      // But the intent is to check if someone passes an absolute path as the file
      expect(isPathWithinRoot('/repo', '/etc/passwd')).toBe(true); // This is /repo/etc/passwd
    });
  });

  describe('copyWorktreeFile', () => {
    let statSpy: Mock<typeof fs.stat>;
    let mkdirSpy: Mock<typeof fs.mkdir>;
    let copyFileSpy: Mock<typeof fs.copyFile>;
    let cpSpy: Mock<typeof fs.cp>;

    beforeEach(() => {
      statSpy = spyOn(fs, 'stat');
      mkdirSpy = spyOn(fs, 'mkdir');
      copyFileSpy = spyOn(fs, 'copyFile');
      cpSpy = spyOn(fs, 'cp');

      mkdirSpy.mockResolvedValue(undefined);
      copyFileSpy.mockResolvedValue(undefined);
      cpSpy.mockResolvedValue(undefined);
    });

    afterEach(() => {
      statSpy.mockRestore();
      mkdirSpy.mockRestore();
      copyFileSpy.mockRestore();
      cpSpy.mockRestore();
    });

    test('copies file when source exists', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(true);
      expect(copyFileSpy).toHaveBeenCalledWith(join('/repo', '.env'), join('/worktree', '.env'));
    });

    test('copies directory recursively', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => true } as Stats);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: 'data/fixtures',
        destination: 'data/fixtures',
      });

      expect(result).toBe(true);
      expect(cpSpy).toHaveBeenCalledWith(
        join('/repo', 'data', 'fixtures'),
        join('/worktree', 'data', 'fixtures'),
        { recursive: true }
      );
    });

    test('creates destination directory before copying', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      await copyWorktreeFile('/repo', '/worktree', {
        source: 'nested/path/.env',
        destination: 'nested/path/.env',
      });

      expect(mkdirSpy).toHaveBeenCalledWith(join('/worktree', 'nested', 'path'), {
        recursive: true,
      });
    });

    test('returns false when source does not exist (ENOENT)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      statSpy.mockRejectedValue(error);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(false);
    });

    test('returns false on permission error (EACCES) without throwing', async () => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      statSpy.mockRejectedValue(error);

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(false);
    });

    // Path traversal tests
    test('blocks source path traversal', async () => {
      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '../../../etc/passwd',
        destination: 'stolen.txt',
      });

      expect(result).toBe(false);
      // Should NOT call stat - blocked before any fs operation
      expect(statSpy).not.toHaveBeenCalled();
    });

    test('blocks destination path traversal', async () => {
      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '../../../tmp/evil.txt',
      });

      expect(result).toBe(false);
      // Should NOT call stat - blocked before any fs operation
      expect(statSpy).not.toHaveBeenCalled();
    });

    // Copy operation failure tests
    test('returns false when copyFile throws', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);
      copyFileSpy.mockRejectedValue(new Error('Disk full'));

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: '.env',
        destination: '.env',
      });

      expect(result).toBe(false);
    });

    test('returns false when cp throws for directory', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => true } as Stats);
      cpSpy.mockRejectedValue(new Error('Permission denied'));

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: 'data/',
        destination: 'data/',
      });

      expect(result).toBe(false);
    });

    test('returns false when mkdir fails', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);
      mkdirSpy.mockRejectedValue(new Error('Cannot create directory'));

      const result = await copyWorktreeFile('/repo', '/worktree', {
        source: 'nested/path/.env',
        destination: 'nested/path/.env',
      });

      expect(result).toBe(false);
    });
  });

  describe('copyWorktreeFiles', () => {
    let statSpy: Mock<typeof fs.stat>;
    let mkdirSpy: Mock<typeof fs.mkdir>;
    let copyFileSpy: Mock<typeof fs.copyFile>;
    let cpSpy: Mock<typeof fs.cp>;

    beforeEach(() => {
      statSpy = spyOn(fs, 'stat');
      mkdirSpy = spyOn(fs, 'mkdir');
      copyFileSpy = spyOn(fs, 'copyFile');
      cpSpy = spyOn(fs, 'cp');

      mkdirSpy.mockResolvedValue(undefined);
      copyFileSpy.mockResolvedValue(undefined);
      cpSpy.mockResolvedValue(undefined);
    });

    afterEach(() => {
      statSpy.mockRestore();
      mkdirSpy.mockRestore();
      copyFileSpy.mockRestore();
      cpSpy.mockRestore();
    });

    test('copies multiple files from config', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', [
        '.env',
        '.vscode/settings.json',
      ]);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
      expect(result[1]).toEqual({
        source: '.vscode/settings.json',
        destination: '.vscode/settings.json',
      });
    });

    test('returns only successfully copied entries', async () => {
      // First call succeeds, second fails with ENOENT
      statSpy
        .mockResolvedValueOnce({ isDirectory: () => false } as Stats)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const result = await copyWorktreeFiles('/repo', '/worktree', ['.env', '.archon']);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
    });

    test('returns empty array when no files configured', async () => {
      const result = await copyWorktreeFiles('/repo', '/worktree', []);

      expect(result).toHaveLength(0);
    });

    test('handles mixed files and directories', async () => {
      statSpy
        .mockResolvedValueOnce({ isDirectory: () => false } as Stats)
        .mockResolvedValueOnce({ isDirectory: () => true } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', ['.env', 'data/fixtures/']);

      expect(result).toHaveLength(2);
      expect(copyFileSpy).toHaveBeenCalledTimes(1);
      expect(cpSpy).toHaveBeenCalledTimes(1);
    });

    // Parse error handling
    test('continues processing after invalid config entry', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', [
        '', // Invalid - empty
        '.env', // Valid
        '   ', // Invalid - whitespace only
        '.vscode/settings.json', // Valid
      ]);

      // Should have only the 2 valid entries
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
      expect(result[1]).toEqual({
        source: '.vscode/settings.json',
        destination: '.vscode/settings.json',
      });
    });

    test('skips entries with path traversal', async () => {
      statSpy.mockResolvedValue({ isDirectory: () => false } as Stats);

      const result = await copyWorktreeFiles('/repo', '/worktree', [
        '.env', // Valid
        '../../../etc/passwd', // Path traversal - blocked
        'data/config.json', // Valid
      ]);

      // Path traversal entry should be skipped
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ source: '.env', destination: '.env' });
      expect(result[1]).toEqual({ source: 'data/config.json', destination: 'data/config.json' });
    });
  });
});

describe('worktree-copy never overwrites a tracked path (WO-HARNESS-WORKTREE-SYNC-NO-TRACKED-OVERWRITE-01)', () => {
  const NEW = 'text: new staging wording\n';
  const OLD = 'text: old master wording\n';
  let root: string;
  let canonical: string;
  let worktree: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  function write(base: string, rel: string, content: string): void {
    const full = join(base, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wt-copy-tracked-'));
    canonical = join(root, 'canonical');
    worktree = join(root, 'worktree');
    mkdirSync(canonical, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    // The worktree is a real git checkout whose tracked .archon files hold the NEW text.
    git(worktree, 'init', '-q');
    git(worktree, 'config', 'user.email', 't@example.com');
    git(worktree, 'config', 'user.name', 't');
    git(worktree, 'config', 'core.autocrlf', 'false');
    write(worktree, '.archon/workflows/a.yaml', NEW);
    write(worktree, '.archon/workflows/c.yaml', NEW);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'base');
    // The canonical source checkout is on another branch: its copy of a.yaml is OLD.
    write(canonical, '.archon/workflows/a.yaml', OLD);
    write(canonical, '.archon/workflows/c.yaml', NEW);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a tracked file keeps the worktree content and the worktree stays clean (Test 1)', async () => {
    await copyWorktreeFiles(canonical, worktree, ['.archon']);

    expect(readFileSync(join(worktree, '.archon/workflows/a.yaml'), 'utf8')).toBe(NEW);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  test('untracked and new files are still copied (Test 2)', async () => {
    write(canonical, '.archon/config.yaml', 'local: only\n');
    write(canonical, '.archon/extra/b.yaml', 'extra: yes\n');

    await copyWorktreeFiles(canonical, worktree, ['.archon']);

    expect(readFileSync(join(worktree, '.archon/config.yaml'), 'utf8')).toBe('local: only\n');
    expect(readFileSync(join(worktree, '.archon/extra/b.yaml'), 'utf8')).toBe('extra: yes\n');
    expect(readFileSync(join(worktree, '.archon/workflows/a.yaml'), 'utf8')).toBe(NEW);
    const status = git(worktree, 'status', '--porcelain', '--untracked-files=all')
      .trim()
      .split('\n');
    // only the two copied local-only files are new; no tracked file shows as modified
    expect(status.filter(line => line.startsWith(' M') || line.startsWith('M '))).toEqual([]);
    expect(status.length).toBe(2);
  });

  test('a tracked single-file entry and a mixed directory entry (Test 3)', async () => {
    write(canonical, '.archon/workflows/new-only.yaml', 'only: canonical\n');

    const single = await copyWorktreeFile(canonical, worktree, {
      source: '.archon/workflows/a.yaml',
      destination: '.archon/workflows/a.yaml',
    });
    expect(single).toBe(true);
    expect(readFileSync(join(worktree, '.archon/workflows/a.yaml'), 'utf8')).toBe(NEW);

    const dir = await copyWorktreeFile(canonical, worktree, {
      source: '.archon/workflows',
      destination: '.archon/workflows',
    });
    expect(dir).toBe(true);
    expect(readFileSync(join(worktree, '.archon/workflows/a.yaml'), 'utf8')).toBe(NEW);
    expect(readFileSync(join(worktree, '.archon/workflows/new-only.yaml'), 'utf8')).toBe(
      'only: canonical\n'
    );
  });

  test('never follows a tracked destination symlink to overwrite a tracked file outside the folder (Overseer finding on bdc-harness#1565)', async () => {
    // The worktree tracks .archon/workflows as a symlink to ../actual, and actual/a.yaml is tracked.
    rmSync(join(worktree, '.archon/workflows'), { recursive: true, force: true });
    write(worktree, 'actual/a.yaml', NEW);
    git(worktree, 'config', 'core.symlinks', 'true');
    symlinkSync(join('..', 'actual'), join(worktree, '.archon/workflows'), 'dir');
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'workflows is a symlink');
    const mode = git(worktree, 'ls-files', '-s', '.archon/workflows').split(' ')[0];
    if (mode !== '120000') return; // this platform cannot store the symlink; nothing to prove here

    await copyWorktreeFiles(canonical, worktree, ['.archon']);
    expect(readFileSync(join(worktree, 'actual/a.yaml'), 'utf8')).toBe(NEW);
    expect(git(worktree, 'status', '--porcelain').trim()).toBe('');

    const single = await copyWorktreeFile(canonical, worktree, {
      source: '.archon/workflows/a.yaml',
      destination: '.archon/workflows/a.yaml',
    });
    expect(single).toBe(true);
    expect(readFileSync(join(worktree, 'actual/a.yaml'), 'utf8')).toBe(NEW);
    expect(git(worktree, 'status', '--porcelain').trim()).toBe('');
  });

  test('never follows an untracked destination symlink either', async () => {
    const elsewhere = join(root, 'elsewhere');
    write(elsewhere, 'a.yaml', 'precious: yes\n');
    rmSync(join(worktree, '.archon/workflows'), { recursive: true, force: true });
    try {
      symlinkSync(elsewhere, join(worktree, '.archon/workflows'), 'dir');
    } catch {
      return; // symlinks unavailable here
    }

    await copyWorktreeFiles(canonical, worktree, ['.archon']);

    expect(readFileSync(join(elsewhere, 'a.yaml'), 'utf8')).toBe('precious: yes\n');
  });

  test('an untracked symlink under an untracked .archon is not followed when nothing under .archon is tracked (Overseer finding 2 on bdc-harness#1565)', async () => {
    // Only actual/a.yaml is tracked; .archon holds nothing tracked, and .archon/workflows is an untracked link.
    rmSync(join(worktree, '.archon'), { recursive: true, force: true });
    write(worktree, 'actual/a.yaml', NEW);
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', 'only actual is tracked');
    mkdirSync(join(worktree, '.archon'), { recursive: true });
    try {
      symlinkSync(join('..', 'actual'), join(worktree, '.archon/workflows'), 'dir');
    } catch {
      return; // symlinks unavailable here
    }

    await copyWorktreeFiles(canonical, worktree, ['.archon']);

    expect(readFileSync(join(worktree, 'actual/a.yaml'), 'utf8')).toBe(NEW);
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
      'actual/a.yaml'
    );
  });

  test('a tracked directory deleted locally is not restored from the canonical branch (Overseer finding 3 on bdc-harness#1565)', async () => {
    // .archon/workflows/a.yaml is tracked in the worktree (NEW); the local checkout deleted the folder.
    rmSync(join(worktree, '.archon'), { recursive: true, force: true });

    await copyWorktreeFiles(canonical, worktree, ['.archon']);

    // a tracked file must not reappear with the canonical branch's older text
    expect(existsSync(join(worktree, '.archon/workflows/a.yaml'))).toBe(false);
    expect(existsSync(join(worktree, '.archon/workflows/c.yaml'))).toBe(false);
  });

  test('a git checkout whose tracked listing fails gets no copy at all (fail closed)', async () => {
    const broken = join(root, 'broken');
    mkdirSync(broken, { recursive: true });
    // a .git entry that git cannot read: this is a checkout, but its tracked paths cannot be listed
    writeFileSync(join(broken, '.git'), 'gitdir: ' + join(root, 'does-not-exist') + '\n');

    const copied = await copyWorktreeFiles(canonical, broken, ['.archon']);

    expect(copied).toEqual([]);
    expect(existsSync(join(broken, '.archon'))).toBe(false);
  });

  test('a destination that is not a git checkout is copied as before', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });

    await copyWorktreeFiles(canonical, plain, ['.archon']);

    expect(readFileSync(join(plain, '.archon/workflows/a.yaml'), 'utf8')).toBe(OLD);
  });
});
