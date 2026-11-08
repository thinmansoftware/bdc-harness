import { findCodebaseByName } from '@archon/core/db/codebases';
import { parseProjectRecord } from '@archon/core/grimoire/project-record';
import { resolveExecutionMergeRepoPolicy } from '@archon/overseer/merge-execution-bridge';
import { getRepoBasePolicy } from '@archon/overseer/merge-repo-policy';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Surface {
  surface: string;
  status: 'AGREE' | 'DISAGREE' | 'UNREADABLE' | 'SKIPPED';
  record?: unknown;
  live?: unknown;
  reason?: string;
}

export function redactRepositoryUrl(url: string | null): string | null {
  return url?.replace(/(https?:\/\/)[^/]*@/gi, '$1***@') ?? null;
}

// These files use repo keys. Arrays of project entries are also accepted.
function entryFor(data: unknown, repo: string): unknown {
  if (Array.isArray(data))
    return data.find(
      entry => entry?.repo === repo || entry?.name === repo || entry?.repository === repo
    );
  if (!data || typeof data !== 'object') return undefined;
  const entries = data as Record<string, unknown>;
  return (
    entries[repo] ??
    entries[repo.split('/')[1] ?? ''] ??
    (entries.projects ? entryFor(entries.projects, repo) : undefined)
  );
}

function canonicalContains(data: unknown, repo: string): boolean {
  if (typeof data === 'string') return data === repo;
  if (Array.isArray(data)) return data.some(entry => canonicalContains(entry, repo));
  if (!data || typeof data !== 'object') return false;
  return Object.entries(data).some(
    ([key, value]) => key === repo || canonicalContains(value, repo)
  );
}

export async function projectCommand(
  command: string | undefined,
  repo: string | undefined,
  options: { xoRoot?: string; json?: boolean } = {}
): Promise<number> {
  if (!repo || !['show', 'verify'].includes(command ?? '')) {
    console.error('Usage: archon project show|verify <owner/repo> [--xo-root <path>] [--json]');
    return 2;
  }
  const row = await findCodebaseByName(repo, { readonly: true });
  const parsed = parseProjectRecord(row?.project_record);
  const error = !row
    ? 'REPO_NOT_REGISTERED'
    : parsed.status === 'invalid'
      ? 'RECORD_UNPARSEABLE'
      : parsed.status === 'absent'
        ? 'NO_RECORD'
        : undefined;
  if (command === 'show' || error) {
    console.log(
      JSON.stringify(
        {
          codebase: row
            ? {
                ...row,
                repository_url: redactRepositoryUrl(row.repository_url),
                project_record: parsed.record,
              }
            : null,
          project_record: parsed.record,
          ...(error ? { error } : {}),
        },
        null,
        2
      )
    );
    return error ? 2 : 0;
  }
  if (!row || parsed.status !== 'valid') return 2;
  const record = parsed.record;
  const surfaces: Surface[] = [];
  const check = (surface: string, agrees: boolean, expected: unknown, live: unknown): void => {
    surfaces.push({
      surface,
      status: agrees ? 'AGREE' : 'DISAGREE',
      record: expected,
      live: live ?? null,
    });
  };
  check(
    'codebase.default_branch',
    row.default_branch === record.base_branch,
    record.base_branch,
    row.default_branch
  );
  // Judge branches with merge execution's own effective policy (including the
  // deprecated OVERSEER_MERGE_REPO_CONFIG) and its lookup (trim + lowercase), so
  // verify can never disagree with what merge execution would actually do.
  const policy = resolveExecutionMergeRepoPolicy();
  const bases = policy[repo.trim().toLowerCase()] ?? {};
  check(
    'merge_policy.base',
    getRepoBasePolicy(repo, record.base_branch, policy) !== undefined,
    record.base_branch,
    Object.keys(bases)
  );
  const unattended = record.production_branches.filter(
    branch => getRepoBasePolicy(repo, branch, policy)?.unattended === true
  );
  check('merge_policy.production', unattended.length === 0, record.production_branches, unattended);
  for (const [surface, file] of [
    ['xo.repo_canonical_map', 'repo-canonical-map.json'],
    ['xo.cauldron_projects_base', 'cauldron-projects.json'],
  ]) {
    if (!options.xoRoot) {
      surfaces.push({ surface, status: 'SKIPPED', reason: 'no --xo-root' });
      continue;
    }
    try {
      const data: unknown = JSON.parse(
        await readFile(join(options.xoRoot, 'scripts/cauldron', file), 'utf8')
      );
      const entry = entryFor(data, repo);
      if (surface === 'xo.repo_canonical_map') {
        check(surface, canonicalContains(data, repo), repo, entry);
      } else {
        const base =
          entry && typeof entry === 'object'
            ? (entry as Record<string, unknown>).base_branch
            : undefined;
        check(surface, base === record.base_branch, record.base_branch, base);
      }
    } catch {
      surfaces.push({ surface, status: 'UNREADABLE', reason: `cannot read or parse ${file}` });
    }
  }
  const exitCode = surfaces.some(s => s.status === 'DISAGREE')
    ? 1
    : surfaces.some(s => s.status === 'UNREADABLE')
      ? 3
      : 0;
  if (options.json) console.log(JSON.stringify({ repo, surfaces, exitCode }, null, 2));
  else
    for (const s of surfaces) {
      const value = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
      console.log(
        `${s.status} ${s.surface}${s.status === 'DISAGREE' ? ` record=${value(s.record)} live=${value(s.live)}` : s.reason ? ` ${s.reason}` : ''}`
      );
    }
  return exitCode;
}
