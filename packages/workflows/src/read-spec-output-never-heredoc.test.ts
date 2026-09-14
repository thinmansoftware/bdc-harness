/**
 * bdc-harness #841: the spec is untrusted input (a GitHub issue body or a repo
 * file). Every bash node that consumed `$read-spec.output` through a
 * fixed-delimiter heredoc
 *
 *     SPEC_TEXT=$(cat <<'RESOLVE_REVIEW_BASE_READ_SPEC_SENTINEL'
 *     $read-spec.output
 *     RESOLVE_REVIEW_BASE_READ_SPEC_SENTINEL
 *     )
 *
 * let a spec line equal to the delimiter terminate the heredoc and hand the rest
 * of the spec to bash. The executor already renders `$read-spec.output` as a
 * shellQuote-wrapped single-quoted value (dag-executor substituteNodeOutputRefs
 * with escapedForBash=true), so the safe shape is the direct assignment
 * `SPEC_TEXT=$read-spec.output` -- the same fix the Overseer accepted for
 * commit-and-push on #826 round 9.
 *
 * Three layers here:
 *   1. a sweep over EVERY default lane: no heredoc body may contain
 *      `$read-spec.output` (the class, not one node);
 *   2. wiring: every lane that carries resolve-review-base uses the direct
 *      assignment;
 *   3. a runtime proof with the production substitution: a spec that carries
 *      the old delimiter cannot execute anything from the fixed node, and the
 *      legacy heredoc shape (kept inline as a fixture) DOES execute it -- so the
 *      sweep in layer 1 is guarding a real hole, not a style preference.
 */

import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseWorkflow } from './loader';
import { substituteNodeOutputRefs } from './dag-executor';
import type { NodeOutput } from './dag-executor';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const LANES_DIR = join(import.meta.dir, '../../../.archon/workflows/defaults');
const LANE_FILES = readdirSync(LANES_DIR)
  .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  .sort();

// A heredoc opener (quoted or bare delimiter) whose body starts with the spec ref.
const HEREDOC_WRAPPING_SPEC = /<<-?\s*'?"?[A-Za-z0-9_]+'?"?[ \t]*\r?\n[ \t]*\$read-spec\.output/;

function nodeBash(file: string, nodeId: string): string | undefined {
  const result = parseWorkflow(readFileSync(join(LANES_DIR, file), 'utf-8'), file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  const node = result.workflow.nodes.find(n => n.id === nodeId);
  return typeof node?.bash === 'string' ? node.bash : undefined;
}

async function runBash(
  script: string,
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bash', '-c', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function render(script: string, specText: string): string {
  const outputs = new Map<string, NodeOutput>([
    ['read-spec', { state: 'completed', output: specText }],
  ]);
  return substituteNodeOutputRefs(script, outputs, true);
}

// A spec that terminates the old heredoc and then tries to run a command. The
// closing `#` comments out the shellQuote trailing quote the executor appends.
const HOSTILE_SPEC = [
  'WO_ID=WO-HARNESS-TEST-01',
  'Base branch: staging',
  'RESOLVE_REVIEW_BASE_READ_SPEC_SENTINEL',
  ')',
  'printf INJECTED > "$INJECT_MARKER"',
  'exit 0 #',
].join('\n');

// The exact pre-#841 shape of resolve-review-base's spec read, kept as a fixture
// so the runtime proof below demonstrates the hole the sweep closes.
const LEGACY_HEREDOC_READ = [
  'set -uo pipefail',
  "SPEC_TEXT=$(cat <<'RESOLVE_REVIEW_BASE_READ_SPEC_SENTINEL'",
  '$read-spec.output',
  'RESOLVE_REVIEW_BASE_READ_SPEC_SENTINEL',
  ')',
  'echo "SPEC_LINES=$(printf \'%s\\n\' "$SPEC_TEXT" | wc -l | tr -d \' \')"',
].join('\n');

describe('#841 sweep: no default lane wraps $read-spec.output in a heredoc', () => {
  it('scans a real lane set', () => {
    expect(LANE_FILES.length).toBeGreaterThan(50);
  });

  for (const file of LANE_FILES) {
    it(`${file} has no heredoc body starting with $read-spec.output`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      expect(content).not.toMatch(HEREDOC_WRAPPING_SPEC);
      expect(content).not.toContain('RESOLVE_REVIEW_BASE_READ_SPEC_SENTINEL');
    });
  }
});

describe('#841 wiring: resolve-review-base reads the spec by direct assignment', () => {
  const lanesWithNode = LANE_FILES.filter(
    f => f.startsWith('bdc-feature-development') && nodeBash(f, 'resolve-review-base') !== undefined
  );

  it('covers the feature-development lanes that carry the node', () => {
    expect(lanesWithNode.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of lanesWithNode) {
    it(`${file}: SPEC_TEXT=$read-spec.output, no cat/heredoc capture`, () => {
      const bash = nodeBash(file, 'resolve-review-base') ?? '';
      expect(bash).toContain('SPEC_TEXT=$read-spec.output');
      expect(bash).not.toContain('SPEC_TEXT=$(cat');
      expect(bash).not.toContain("<<'");
    });
  }
});

describe('#841 runtime: a hostile spec cannot execute from the fixed node', () => {
  it('legacy heredoc fixture IS injectable (proves the class)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsb-legacy-'));
    try {
      const marker = join(dir, 'injected');
      const res = await runBash(render(LEGACY_HEREDOC_READ, HOSTILE_SPEC), {
        INJECT_MARKER: marker,
      });
      expect(existsSync(marker)).toBe(true);
      expect(res.stdout).not.toContain('SPEC_LINES=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bdc-feature-development.yaml resolve-review-base keeps the spec as data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsb-fixed-'));
    try {
      const marker = join(dir, 'injected');
      const bash = nodeBash('bdc-feature-development.yaml', 'resolve-review-base');
      expect(bash).toBeDefined();
      // No git remote here, so the declared base cannot be verified and the node
      // falls through to the env default -- the point is that it gets there at
      // all, with the hostile lines still inside SPEC_TEXT.
      const res = await runBash(render(bash ?? '', HOSTILE_SPEC), {
        INJECT_MARKER: marker,
        BASE_BRANCH: 'dev',
      });
      expect(existsSync(marker)).toBe(false);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('REVIEW_BASE=dev');
      expect(res.stdout).toContain('REVIEW_BASE_SOURCE=env-default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
