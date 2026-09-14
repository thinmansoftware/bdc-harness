import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { CanaryVerdict } from './types';

interface Query<T> {
  all(...params: unknown[]): T[];
  get(...params: unknown[]): T | null;
}

export interface OutcomeCanaryDatabase {
  query<T>(sql: string): Query<T>;
}

export interface OutcomeCanaryResult {
  /** Canary id (C1..C6) when part of a composed suite. */
  readonly id?: string;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly checks?: readonly OutcomeCanaryResult[];
}

export interface OutcomeCanaryDeps {
  readonly dbPath?: string;
  readonly db?: OutcomeCanaryDatabase;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
  readonly statusUrl?: string;
  readonly operatorToken?: string;
}

export function openOutcomeDatabase(
  deps: OutcomeCanaryDeps,
  missingPathCode: string
): { db: OutcomeCanaryDatabase; close: () => void } {
  if (deps.db) return { db: deps.db, close: () => undefined };
  if (!deps.dbPath) throw new Error(missingPathCode);
  const db = new Database(deps.dbPath, { readonly: true });
  return {
    db,
    close: (): void => {
      db.close();
    },
  };
}

export function failResult(
  reasonCode: string,
  evidenceRefs: readonly string[]
): OutcomeCanaryResult {
  return { verdict: 'failed', reasonCodes: [reasonCode], evidenceRefs };
}

/** A canary that could not run for a stated, expected reason (missing client, opt-in absent). */
export function blockedResult(
  reasonCode: string,
  evidenceRefs: readonly string[]
): OutcomeCanaryResult {
  return { verdict: 'blocked', reasonCodes: [reasonCode], evidenceRefs };
}

export function passResult(evidenceRefs: readonly string[]): OutcomeCanaryResult {
  return { verdict: 'passed', reasonCodes: [], evidenceRefs };
}

export function combineOutcomeChecks(checks: readonly OutcomeCanaryResult[]): OutcomeCanaryResult {
  const failed = checks.some(check => check.verdict === 'failed');
  const blocked = checks.some(check => check.verdict === 'blocked');
  return {
    verdict: failed ? 'failed' : blocked ? 'blocked' : 'passed',
    reasonCodes: checks.flatMap(check => check.reasonCodes),
    evidenceRefs: checks.flatMap(check => check.evidenceRefs),
    checks,
  };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeOutcomeCanaryArtifacts(
  outputRoot: string,
  prefix: string,
  report: OutcomeCanaryResult
): Promise<string[]> {
  const directory = join(outputRoot, `${prefix}-${randomUUID()}`);
  const path = join(directory, 'summary.json');
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((await readIfPresent(path)) !== content) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return [path];
}
