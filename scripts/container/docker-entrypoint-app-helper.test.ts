/**
 * docker-entrypoint.sh builder App credential-helper gate
 * (WO-HARNESS-BUILDER-IDENTITY-NO-REVIEWER-FALLBACK-01, Test 4).
 *
 * Lifts the real `if`-condition out of docker-entrypoint.sh (no re-typed copy)
 * and evaluates it with bash under the four env setups to prove the App helper
 * installs ONLY for a distinct builder App:
 *   (a) GITHUB_APP_ID=1 only                       -> false
 *   (b) GITHUB_APP_ID=1 + GITHUB_APP_RUN_NODES_ID=1 -> false (equal -> error path)
 *   (c) GITHUB_APP_ID=1 + GITHUB_APP_RUN_NODES_ID=5 -> true  (install path)
 *   (d) GITHUB_APP_TASKMASTER_ID=3 only            -> false (RUN_NODES unset)
 * Also asserts the Taskmaster App token is gone from the file.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const entrypoint = readFileSync(new URL('../../docker-entrypoint.sh', import.meta.url), 'utf8');

/** The real install `if`-line, lifted verbatim from docker-entrypoint.sh. */
function extractInstallCondition(source: string): string {
  const line = source
    .split('\n')
    .find(l => l.trimStart().startsWith('if ') && l.includes('GITHUB_APP_RUN_NODES_ID'));
  if (!line) throw new Error('install if-line not found in docker-entrypoint.sh');
  const match = line.match(/^\s*if\s+(.*?);\s*then\s*$/);
  if (!match) throw new Error(`could not parse if-condition from: ${line}`);
  return match[1];
}

function evalCondition(condition: string, env: Record<string, string>): boolean {
  const script = `if ${condition}; then echo true; else echo false; fi\n`;
  const out = execFileSync('bash', ['-c', script], {
    env: { ...env },
    encoding: 'utf8',
  }).trim();
  return out === 'true';
}

describe('Test 4: entrypoint installs App helper only for a distinct builder App', () => {
  const condition = extractInstallCondition(entrypoint);

  it('(a) reviewer App only -> false', () => {
    expect(evalCondition(condition, { GITHUB_APP_ID: '1' })).toBe(false);
  });

  it('(b) builder App equals reviewer App -> false', () => {
    expect(evalCondition(condition, { GITHUB_APP_ID: '1', GITHUB_APP_RUN_NODES_ID: '1' })).toBe(
      false
    );
  });

  it('(c) distinct builder App -> true', () => {
    expect(evalCondition(condition, { GITHUB_APP_ID: '1', GITHUB_APP_RUN_NODES_ID: '5' })).toBe(
      true
    );
  });

  it('(d) taskmaster App only -> false', () => {
    expect(evalCondition(condition, { GITHUB_APP_TASKMASTER_ID: '3' })).toBe(false);
  });

  it('no longer keys on the Taskmaster App id', () => {
    expect(entrypoint).not.toContain('GITHUB_APP_TASKMASTER_ID');
  });
});
