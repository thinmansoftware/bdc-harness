/**
 * Resolve a T3 command's project to its registered codebase.
 *
 * T3 fire commands (bdc-xo scripts/t3-bridge/command.mjs) name a project the way
 * fire.ps1 and taskmaster/fire-eligibility.ts do: the bare repo name ('bdc-xo').
 * Registered codebases are named 'owner/repo'. An exact name wins; otherwise a bare
 * name matches the single codebase whose last path segment equals it. Two or more
 * candidates is ambiguous and resolves to nothing (fail closed). Matching is
 * case-insensitive, like normalizeRepo, and never by substring.
 */
export interface ProjectCodebaseRow {
  name: string;
  repository_url: string | null;
}

export function matchProjectCodebase<T extends ProjectCodebaseRow>(
  codebases: readonly T[],
  project: string
): T | undefined {
  const wanted = project.trim().toLowerCase();
  if (!wanted) return undefined;
  const exact = codebases.filter(entry => entry.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  if (wanted.includes('/')) return undefined;
  const bare = codebases.filter(
    entry => entry.name.trim().toLowerCase().split('/').at(-1) === wanted
  );
  return bare.length === 1 ? bare[0] : undefined;
}
