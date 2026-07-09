/**
 * Local worktree tools for the Grok agent tool loop.
 * Paths are resolved under cwd; traversal outside cwd is rejected.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';

const execFileAsync = promisify(execFile);

export const GROK_AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description:
        'Run a shell command in the worktree cwd. Use for git, tests, builds, and inspection.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file relative to the worktree cwd.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under cwd' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file relative to the worktree cwd.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path under cwd' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Replace the first occurrence of old_string with new_string in a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: 'List directory entries relative to the worktree cwd.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative directory path (default ".")',
          },
        },
        required: [],
      },
    },
  },
];

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function resolveInCwd(cwd: string, relPath: string): string {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (isAbsolute(cleaned) || cleaned.split('/').includes('..')) {
    throw new Error(`Path escapes cwd: ${relPath}`);
  }
  const full = resolve(cwd, cleaned);
  const rel = relative(cwd, full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes cwd: ${relPath}`);
  }
  return full;
}

export async function executeGrokTool(
  cwd: string,
  name: string,
  argsJson: string,
  options?: { bashTimeoutMs?: number }
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return `ERROR: invalid tool args JSON: ${argsJson.slice(0, 200)}`;
  }

  try {
    switch (name) {
      case 'bash': {
        const command = asString(args.command);
        if (!command) return 'ERROR: command required';
        const timeout = options?.bashTimeoutMs ?? 120_000;
        const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
        const shellArgs =
          process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
        try {
          const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
            cwd,
            timeout,
            maxBuffer: 8 * 1024 * 1024,
            env: process.env,
            windowsHide: true,
          });
          const out = `${stdout ?? ''}${stderr ? `\nSTDERR:\n${stderr}` : ''}`.trim();
          return out.length > 0 ? out.slice(0, 100_000) : '(no output)';
        } catch (err) {
          const e = err as {
            stdout?: string;
            stderr?: string;
            message?: string;
            code?: number | string;
          };
          const body = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? String(err)}`.trim();
          return `ERROR bash exit=${String(e.code ?? '?')}:\n${body.slice(0, 100_000)}`;
        }
      }
      case 'read_file': {
        const path = asString(args.path);
        const full = resolveInCwd(cwd, path);
        if (!existsSync(full)) return `ERROR: file not found: ${path}`;
        const text = readFileSync(full, 'utf8');
        return text.length > 200_000 ? text.slice(0, 200_000) + '\n...[truncated]' : text;
      }
      case 'write_file': {
        const path = asString(args.path);
        const content = asString(args.content);
        const full = resolveInCwd(cwd, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, 'utf8');
        return `OK wrote ${path} (${content.length} bytes)`;
      }
      case 'edit_file': {
        const path = asString(args.path);
        const oldStr = asString(args.old_string);
        const newStr = asString(args.new_string);
        const full = resolveInCwd(cwd, path);
        if (!existsSync(full)) return `ERROR: file not found: ${path}`;
        const text = readFileSync(full, 'utf8');
        if (!text.includes(oldStr)) return `ERROR: old_string not found in ${path}`;
        writeFileSync(full, text.replace(oldStr, newStr), 'utf8');
        return `OK edited ${path}`;
      }
      case 'list_dir': {
        const path = asString(args.path, '.');
        const full = resolveInCwd(cwd, path === '' ? '.' : path);
        if (!existsSync(full)) return `ERROR: dir not found: ${path}`;
        const st = statSync(full);
        if (!st.isDirectory()) return `ERROR: not a directory: ${path}`;
        const entries = readdirSync(full).map(name => {
          const s = statSync(join(full, name));
          return `${s.isDirectory() ? 'd' : 'f'} ${name}`;
        });
        return entries.join('\n') || '(empty)';
      }
      default:
        return `ERROR: unknown tool ${name}`;
    }
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// silence unused sep on some platforms
void sep;
