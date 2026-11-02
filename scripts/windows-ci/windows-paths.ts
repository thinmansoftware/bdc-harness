import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PATTERNS = join(import.meta.dir, '../../.github/windows-paths.txt');

export function loadWindowsPathPatterns(file: string): string[] {
  const patterns: string[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

function normalizeChangedPath(file: string): string {
  return file.replaceAll('\\', '/');
}

function patternMatches(pattern: string, file: string): boolean {
  if (new Bun.Glob(pattern).match(file)) return true;
  if (pattern.endsWith('/**')) {
    const directChild = `${pattern.slice(0, -3)}/*`;
    if (new Bun.Glob(directChild).match(file)) return true;
  }
  return false;
}

export function shouldRunWindows(
  changedFiles: readonly string[],
  patterns: readonly string[]
): boolean {
  if (changedFiles.length === 0) return false;
  for (const changedFile of changedFiles) {
    const file = normalizeChangedPath(changedFile);
    for (const pattern of patterns) {
      if (patternMatches(pattern, file)) return true;
    }
  }
  return false;
}

interface CliArgs {
  base?: string;
  head?: string;
  patterns?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const result: CliArgs = {};
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? '';
    if (arg === '--base' || arg === '--head' || arg === '--patterns') {
      const key = arg.slice(2) as keyof CliArgs;
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) result[key] = value;
      index += 2;
      continue;
    }
    if (arg.startsWith('--base=') || arg.startsWith('--head=') || arg.startsWith('--patterns=')) {
      const separator = arg.indexOf('=');
      const key = arg.slice(2, separator) as keyof CliArgs;
      const value = arg.slice(separator + 1);
      if (value) result[key] = value;
      index += 1;
      continue;
    }
    index += 1;
  }
  return result;
}

function emit(value: 'true' | 'false'): never {
  process.stdout.write(`run_windows=${value}\n`);
  process.exit(0);
}

function changedFilesBetween(base: string, head: string): string[] {
  const raw = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const diff = typeof raw === 'string' ? raw : String(raw);
  return diff.split(/\r?\n/).filter(line => line.length > 0);
}

function runCli(argv: readonly string[]): never {
  const args = parseArgs(argv);
  if (!args.base || !args.head) emit('true');
  const patterns = loadWindowsPathPatterns(args.patterns ?? DEFAULT_PATTERNS);
  if (patterns.length === 0) emit('true');
  const changedFiles = changedFilesBetween(args.base, args.head);
  emit(shouldRunWindows(changedFiles, patterns) ? 'true' : 'false');
}

if (import.meta.main) {
  try {
    runCli(process.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown error';
    process.stderr.write(`windows-paths: fail closed: ${message}\n`);
    process.stdout.write('run_windows=true\n');
    process.exit(0);
  }
}
