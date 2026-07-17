/**
 * M-42 Slice 8 child evidence verifier.
 * Requires every named child exactly once with nonempty 40-hex identity SHAs,
 * verified commit objects, reviewed_head == pr_head, S4-S7 path ownership,
 * and rejects every S8-owned path in those diffs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED_CHILD_WO_IDS = [
  'WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01',
  'WO-HARNESS-OVERSEER-M31-SUBSTRATE-01',
  'WO-HARNESS-OVERSEER-ESCALATION-BRIEFING-01',
  'WO-HARNESS-OVERSEER-M31-CONTRACT-V2-01',
  'WO-HARNESS-OVERSEER-CONTROL-PLANE-01',
  'WO-HARNESS-OVERSEER-REPAIR-REFIRE-01',
  'WO-HARNESS-OVERSEER-REFRESH-REBASE-01',
  'WO-HARNESS-OVERSEER-LIFECYCLE-SALVAGE-01',
  'WO-HARNESS-OVERSEER-QUALIFIED-MERGE-01',
] as const;

/** S4-S7 action slices that must not touch S8-owned paths. */
export const S4_S7_WO_IDS = [
  'WO-HARNESS-OVERSEER-REPAIR-REFIRE-01',
  'WO-HARNESS-OVERSEER-REFRESH-REBASE-01',
  'WO-HARNESS-OVERSEER-LIFECYCLE-SALVAGE-01',
  'WO-HARNESS-OVERSEER-QUALIFIED-MERGE-01',
] as const;

/** Exact S8 ownership list that S4-S7 must not modify. */
export const S8_OWNED_PATH_PREFIXES = [
  'packages/overseer/src/service.ts',
  'packages/overseer/src/watch.ts',
  'packages/overseer/src/index.ts',
  'packages/overseer/src/integration-manifest.ts',
  'packages/overseer/src/independent-review-evidence.ts',
  'packages/overseer/src/integration-scenarios.ts',
  'packages/overseer/src/activation-package.ts',
  'packages/overseer/package.json',
  'packages/server/src/overseer-runtime.ts',
  'packages/server/src/routes/api.ts',
  'packages/core/src/db/adapters/sqlite.ts',
  'scripts/verify-m42-child-evidence.ts',
  'scripts/verify-m42-independent-review.ts',
  'scripts/scan-changed-secrets.ts',
  'scripts/staging/staging-m42-up.ps1',
  'scripts/staging/staging-overseer-integration.ps1',
  'scripts/staging/staging-m42-up.contract.test.ts',
  'packages/overseer/src/m42-integration-runner.ts',
  'packages/overseer/src/integration-fixtures.ts',
  'docker-compose.m42-staging.yml',
] as const;

const SHA1_RE = /^[0-9a-f]{40}$/;

export interface ChildManifestEntry {
  readonly wo_id: string;
  readonly base_sha: string;
  readonly pr_head: string;
  readonly reviewed_head: string;
  readonly merge_sha: string;
  readonly pr_number?: number;
}

export interface ParentManifestFile {
  readonly children: readonly ChildManifestEntry[];
  readonly head_sha?: string;
  readonly [key: string]: unknown;
}

export interface VerifyDeps {
  readonly revParseVerify?: (sha: string) => boolean;
  readonly diffNameOnly?: (base: string, head: string) => readonly string[];
}

function defaultRevParseVerify(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function defaultDiffNameOnly(base: string, head: string): readonly string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
    });
    return out
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`child_evidence_fail_fast: git diff failed for ${base}...${head}: ${message}`);
  }
}

function isS8OwnedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  for (const owned of S8_OWNED_PATH_PREFIXES) {
    if (normalized === owned || normalized.startsWith(owned + '/')) return true;
  }
  // Broader package export/manifest ownership and overseer integration tests.
  if (normalized === 'packages/overseer/package.json') return true;
  if (normalized.startsWith('packages/overseer/src/__tests__/integration-')) return true;
  if (normalized.startsWith('packages/overseer/src/__tests__/activation-package')) return true;
  if (normalized.startsWith('scripts/scan-changed-secrets')) return true;
  if (normalized.startsWith('scripts/verify-m42-child-evidence')) return true;
  if (normalized.startsWith('scripts/staging/staging-m42')) return true;
  if (normalized.startsWith('scripts/staging/staging-overseer-integration')) return true;
  if (normalized === 'docker-compose.m42-staging.yml') return true;
  return false;
}

export function verifyM42ChildEvidence(
  manifest: ParentManifestFile,
  deps: VerifyDeps = {}
): { ok: true } | { ok: false; errors: string[] } {
  const revParse = deps.revParseVerify ?? defaultRevParseVerify;
  const diffNames = deps.diffNameOnly ?? defaultDiffNameOnly;
  const errors: string[] = [];

  if (!Array.isArray(manifest.children)) {
    return { ok: false, errors: ['manifest.children missing or not an array'] };
  }

  const byId = new Map<string, ChildManifestEntry>();
  for (const child of manifest.children) {
    if (byId.has(child.wo_id)) {
      errors.push(`duplicate child id: ${child.wo_id}`);
      continue;
    }
    byId.set(child.wo_id, child);
  }

  for (const woId of REQUIRED_CHILD_WO_IDS) {
    const child = byId.get(woId);
    if (!child) {
      errors.push(`missing child: ${woId}`);
      continue;
    }
    for (const field of ['base_sha', 'pr_head', 'reviewed_head', 'merge_sha'] as const) {
      const value = child[field];
      if (!value || !SHA1_RE.test(value)) {
        errors.push(`${woId}: invalid ${field}`);
      } else if (!revParse(value)) {
        errors.push(`${woId}: ${field} is not a verified commit object`);
      }
    }
    if (
      SHA1_RE.test(child.pr_head) &&
      SHA1_RE.test(child.reviewed_head) &&
      child.pr_head !== child.reviewed_head
    ) {
      errors.push(`${woId}: reviewed_head != pr_head`);
    }
  }

  // Fail-fast ownership check for S4-S7.
  for (const woId of S4_S7_WO_IDS) {
    const child = byId.get(woId);
    if (!child) continue;
    if (!SHA1_RE.test(child.base_sha) || !SHA1_RE.test(child.pr_head)) continue;
    let paths: readonly string[];
    try {
      paths = diffNames(child.base_sha, child.pr_head);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    for (const path of paths) {
      if (isS8OwnedPath(path)) {
        errors.push(`${woId}: forbidden S8-owned path in diff: ${path}`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

export function loadManifest(path: string): ParentManifestFile {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`manifest not found: ${abs}`);
  }
  return JSON.parse(readFileSync(abs, 'utf8')) as ParentManifestFile;
}

async function main(argv: string[]): Promise<number> {
  let manifestPath = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') manifestPath = argv[++i] ?? '';
  }
  if (!manifestPath) {
    console.error('usage: bun run scripts/verify-m42-child-evidence.ts --manifest <path>');
    return 2;
  }
  try {
    const manifest = loadManifest(manifestPath);
    const result = verifyM42ChildEvidence(manifest);
    if (!result.ok) {
      for (const e of result.errors) console.error(e);
      return 1;
    }
    console.log('CHILD_EVIDENCE=valid');
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
