import { parseDeclaredBaseBranch } from './run-authority';

/**
 * Branch identity recorded on a workflow run (WO-HARNESS-RUN-BRANCH-IDENTITY-01).
 *
 * Pure policy: callers fetch the repair PR base and the project map, then pass
 * those values in. Nothing here calls GitHub, and nothing here supplies a
 * default branch.
 */

const REPAIR_TARGET_PATTERN = /^[ \t]*Repair target: PR #([0-9]+) \(branch ([^)\r\n]+)\)/m;

export interface RepairTarget {
  readonly prNumber: number;
  readonly branch: string;
}

export interface ProjectMapBranchEntry {
  readonly cauldron_base?: string;
  readonly base_branch?: string;
}

export interface RunBranchIdentity {
  readonly base_branch?: string;
  readonly head_branch?: string;
}

export const PROJECT_MAP_API_PATH =
  'repos/thinmansoftware/bdc-xo/contents/scripts/cauldron/cauldron-projects.json?ref=main';

function specText(spec: string | Uint8Array | undefined | null): string {
  if (spec === undefined || spec === null) return '';
  return typeof spec === 'string' ? spec : Buffer.from(spec).toString('utf8');
}

function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A repair declaration is only the line-anchored form
 * `Repair target: PR #<digits> (branch <name>)`, after leading whitespace.
 */
export function parseRepairTarget(
  spec: string | Uint8Array | undefined | null
): RepairTarget | undefined {
  const match = REPAIR_TARGET_PATTERN.exec(specText(spec));
  if (!match) return undefined;
  const prNumber = Number(match[1]);
  const branch = nonEmpty(match[2]);
  if (!Number.isInteger(prNumber) || prNumber < 1 || !branch) return undefined;
  return { prNumber, branch };
}

export function normalizeRepoSlug(value: string | undefined | null): string | undefined {
  const trimmed = nonEmpty(value);
  if (!trimmed) return undefined;
  const full =
    /^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      trimmed
    );
  if (full?.[1]) return full[1].toLowerCase();
  if (/^[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed.toLowerCase();
  return undefined;
}

function repoMatches(target: string, candidate: string): boolean {
  if (candidate === target) return true;
  return !target.includes('/') && candidate.endsWith(`/${target}`);
}

/**
 * Pick the single project-map entry whose `repo` matches `targetRepo`.
 * Zero matches and more than one match are both misses.
 */
export function selectProjectMapBranchEntry(
  projects: unknown,
  targetRepo: string | undefined
): ProjectMapBranchEntry | undefined {
  const target = normalizeRepoSlug(targetRepo);
  if (!target || !projects || typeof projects !== 'object' || Array.isArray(projects)) {
    return undefined;
  }
  const matches: ProjectMapBranchEntry[] = [];
  for (const value of Object.values(projects as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as { repo?: unknown; cauldron_base?: unknown; base_branch?: unknown };
    if (typeof record.repo !== 'string') continue;
    const slug = normalizeRepoSlug(record.repo);
    if (!slug || !repoMatches(target, slug)) continue;
    matches.push({
      cauldron_base: typeof record.cauldron_base === 'string' ? record.cauldron_base : undefined,
      base_branch: typeof record.base_branch === 'string' ? record.base_branch : undefined,
    });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Decode a `gh api` contents response (base64 `content`) into JSON. */
export function decodeGitHubContentsJson(stdout: string): unknown {
  try {
    const envelope = JSON.parse(stdout) as { content?: unknown };
    if (typeof envelope.content !== 'string' || envelope.content.trim().length === 0) {
      return undefined;
    }
    const decoded = Buffer.from(envelope.content.replace(/\s/g, ''), 'base64').toString('utf8');
    return JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }
}

export function repairBaseCommandArgs(prNumber: number, repo: string): string[] {
  return ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'baseRefName'];
}

export function parseRepairBaseStdout(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { baseRefName?: unknown };
    return typeof parsed.baseRefName === 'string' ? nonEmpty(parsed.baseRefName) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recorded base for a new run.
 * Repair: only the live PR base. Anything else is a miss (never the declared base).
 * Otherwise: declared spec base, then cauldron_base, then base_branch. Never a default.
 */
export function resolveRecordedBaseBranch(
  spec: string | Uint8Array | undefined | null,
  projectMapEntry: ProjectMapBranchEntry | undefined,
  liveRepairBaseRefName: string | undefined
): string | undefined {
  if (parseRepairTarget(spec)) {
    return nonEmpty(liveRepairBaseRefName);
  }
  return (
    parseDeclaredBaseBranch(spec) ??
    nonEmpty(projectMapEntry?.cauldron_base) ??
    nonEmpty(projectMapEntry?.base_branch)
  );
}

/**
 * Recorded head for a new run.
 * Repair: the declared repair branch. Otherwise the isolation / checkout branch.
 */
export function resolveRecordedHeadBranch(
  spec: string | Uint8Array | undefined | null,
  isolationBranch: string | undefined
): string | undefined {
  const repair = parseRepairTarget(spec);
  if (repair) return repair.branch;
  return nonEmpty(isolationBranch);
}

/**
 * Refuse to open or retarget a PR when the attempted base disagrees with the
 * base recorded for the run. A missing side is not a mismatch.
 */
export function assertPrBaseAllowed(
  recorded: string | undefined,
  attempted: string | undefined
): void {
  const left = nonEmpty(recorded);
  const right = nonEmpty(attempted);
  if (left && right && left !== right) {
    const error = new Error(`base_branch_mismatch: recorded=${left} attempted=${right}`);
    error.name = 'base_branch_mismatch';
    throw error;
  }
}

export interface BranchIdentityReaders {
  readRepairBase: (prNumber: number, repo: string) => Promise<string | undefined>;
  readProjectMap: (repo: string) => Promise<ProjectMapBranchEntry | undefined>;
}

/**
 * Resolve the metadata keys for one run. Readers perform any GitHub fetches.
 * A reader failure should come back as `undefined` (a miss), not a throw.
 */
export async function resolveRunBranchIdentity(input: {
  spec: string | Uint8Array | undefined | null;
  isolationBranch: string | undefined;
  targetRepo: string | undefined;
  readers: BranchIdentityReaders;
}): Promise<RunBranchIdentity> {
  const repair = parseRepairTarget(input.spec);
  let liveRepairBase: string | undefined;
  let projectMapEntry: ProjectMapBranchEntry | undefined;
  const repo = nonEmpty(input.targetRepo);
  if (repair) {
    if (repo) {
      try {
        liveRepairBase = await input.readers.readRepairBase(repair.prNumber, repo);
      } catch {
        liveRepairBase = undefined;
      }
    }
  } else if (!parseDeclaredBaseBranch(input.spec) && repo && specText(input.spec).length > 0) {
    try {
      projectMapEntry = await input.readers.readProjectMap(repo);
    } catch {
      projectMapEntry = undefined;
    }
  }

  const base = resolveRecordedBaseBranch(input.spec, projectMapEntry, liveRepairBase);
  const head = resolveRecordedHeadBranch(input.spec, input.isolationBranch);
  return {
    ...(base ? { base_branch: base } : {}),
    ...(head ? { head_branch: head } : {}),
  };
}
