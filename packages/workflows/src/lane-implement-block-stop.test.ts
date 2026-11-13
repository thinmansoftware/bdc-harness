import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { evaluateCondition } from './condition-evaluator';
import type { NodeOutput } from './schemas/workflow-run';

// WO-HARNESS-LANE-DPREP-PACKAGE-FOLDER-AND-IMPLEMENT-BLOCK-STOP-01 (Test 6, and the CI wiring of the
// new shell suites). When the implement step of a bdc-feature-development run declared BLOCKED, the nodes
// that repair, push, commit or open a pull request must not run; a missing gate output must skip them too
// (fail closed); and in a normal run each gated node behaves exactly as it did before the change.

const root = join(import.meta.dir, '../../..');
const defaultsDir = join(root, '.archon/workflows/defaults');
const GATE_ID = 'implement-block-gate';
const GATE_COND = "$implement-block-gate.output.terminal == 'no'";
const GATED = [
  'test-repair',
  'run-stop-greps',
  'diff-repair',
  'checkpoint-diff-repair',
  'opus-repair',
  'noninteractive-salvage',
  'apply-suggested-fix',
  'decide-push-target',
  'commit-and-push',
  'open-pr-if-needed',
];

interface LaneNode {
  id: string;
  depends_on?: string[];
  trigger_rule?: string;
  when?: string;
  bash?: string;
}

const LANES = readdirSync(defaultsDir)
  .filter(name => /^bdc-feature-development(-[a-z0-9-]+)?\.yaml$/.test(name))
  .sort();

// Plain YAML parse: the lane schema loader needs every provider registered, which is not what
// this guard is about.
function loadNodes(file: string): LaneNode[] {
  const doc = parseYaml(readFileSync(join(defaultsDir, file), 'utf8')) as { nodes?: LaneNode[] };
  if (!Array.isArray(doc.nodes)) throw new Error(`${file}: no nodes`);
  return doc.nodes;
}

function out(map: Record<string, string>): Map<string, NodeOutput> {
  const m = new Map<string, NodeOutput>();
  for (const [id, output] of Object.entries(map)) m.set(id, { state: 'completed', output });
  return m;
}

// The when: expression as it was before the gate was added: the gate clause removed from every OR clause.
function preChange(when: string): string {
  const clauses = when.split(' || ').map(c => {
    if (c.trim() === GATE_COND) return '';
    return c.endsWith(` && ${GATE_COND}`) ? c.slice(0, -` && ${GATE_COND}`.length) : c;
  });
  if (clauses.every(c => c === '')) return '';
  return clauses.join(' || ');
}

function holds(expr: string, outputs: Map<string, NodeOutput>): boolean {
  return expr === '' ? true : evaluateCondition(expr, outputs).result;
}

const TERMINAL = {
  'implement-block-gate': '{"terminal":"yes","reason":"x"}',
  'repair-gate': '{"REPAIR_GATE":"open","REPAIR_GATE_ALLOW":"yes"}',
  'block-classify': '{"status":"BLOCKED"}',
  'block-reclassify': '{"status":"BLOCKED"}',
  'classify-test-result': '{"status":"failed","repairable":"true"}',
  'classify-diff-review': '{"verdict":"needs_revision"}',
  'classify-apply-review': '{"verdict":"satisfied"}',
  'classify-opus-rereview': '{"verdict":"satisfied"}',
  'pause-gate': '{"decision_verb":"approve_with_fix"}',
};

const NORMAL = [
  {
    ...TERMINAL,
    'implement-block-gate': '{"terminal":"no"}',
    'block-classify': '{"status":"PROCEED"}',
    'block-reclassify': '{"status":"PROCEED"}',
  },
  {
    ...TERMINAL,
    'implement-block-gate': '{"terminal":"no"}',
    'classify-test-result': '{"status":"passed","repairable":"false"}',
    'classify-diff-review': '{"verdict":"satisfied"}',
    'pause-gate': '{"decision_verb":"approve"}',
    'block-reclassify': '{"status":"PROCEED"}',
  },
  {
    ...TERMINAL,
    'implement-block-gate': '{"terminal":"no"}',
    'block-classify': '{"status":"BLOCKED"}',
    'block-reclassify': '{"status":"BLOCKED"}',
    'classify-apply-review': '{"verdict":"needs_revision"}',
    'classify-opus-rereview': '{"verdict":"needs_revision"}',
  },
];

describe('lane lists', () => {
  test('covers all 13 bdc-feature-development lanes', () => {
    expect(LANES.length).toBe(13);
  });
});

for (const lane of LANES) {
  describe(lane, () => {
    const nodes = loadNodes(lane);
    const byId = new Map(nodes.map(n => [n.id, n]));

    test('has exactly one gate node, wired after assert-implement-produced-work', () => {
      expect(nodes.filter(n => n.id === GATE_ID).length).toBe(1);
      const gate = byId.get(GATE_ID);
      expect(gate?.depends_on).toEqual(['assert-implement-produced-work']);
      expect(gate?.trigger_rule).toBe('all_done');
      expect(typeof gate?.bash).toBe('string');
    });

    test('every gated node lists the gate in depends_on and carries it on every OR clause', () => {
      for (const id of GATED) {
        const node = byId.get(id);
        expect(node, `${lane}: ${id} exists`).toBeDefined();
        expect(node?.depends_on, `${lane}: ${id} depends_on`).toContain(GATE_ID);
        expect(typeof node?.when, `${lane}: ${id} has a when`).toBe('string');
        for (const clause of String(node?.when).split(' || ')) {
          expect(clause.includes(GATE_COND), `${lane}: ${id} clause "${clause}"`).toBe(true);
        }
      }
    });

    test('terminal scenario: every gated node is skipped', () => {
      const outputs = out(TERMINAL);
      for (const id of GATED) {
        const when = String(byId.get(id)?.when);
        expect(holds(when, outputs), `${lane}: ${id} must not run`).toBe(false);
      }
    });

    test('missing or failed gate output: every gated node is skipped (fail closed)', () => {
      const { 'implement-block-gate': _gate, ...rest } = TERMINAL;
      void _gate;
      const empty = out({ ...rest, 'implement-block-gate': '' });
      const absent = out(rest);
      const failed = out(rest);
      failed.set(GATE_ID, { state: 'failed', output: '', error: 'boom' });
      for (const id of GATED) {
        const when = String(byId.get(id)?.when);
        expect(holds(when, empty), `${lane}: ${id} with an empty gate output`).toBe(false);
        expect(holds(when, absent), `${lane}: ${id} with no gate output`).toBe(false);
        expect(holds(when, failed), `${lane}: ${id} with a failed gate node`).toBe(false);
      }
    });

    test('normal scenarios: each gated node behaves exactly as it did before the change', () => {
      for (const scenario of NORMAL) {
        const outputs = out(scenario);
        for (const id of GATED) {
          const when = String(byId.get(id)?.when);
          expect(holds(when, outputs), `${lane}: ${id}`).toBe(holds(preChange(when), outputs));
        }
      }
    });

    test('block-classify reads the gate', () => {
      expect(byId.get('block-classify')?.depends_on).toContain(GATE_ID);
    });

    test('every downstream node that pushes, commits or opens a pull request is gated', () => {
      const down = new Set<string>(['assert-implement-produced-work']);
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes) {
          if (!down.has(n.id) && (n.depends_on ?? []).some(d => down.has(d))) {
            down.add(n.id);
            changed = true;
          }
        }
      }
      const pushers = nodes.filter(
        n =>
          down.has(n.id) &&
          typeof n.bash === 'string' &&
          n.bash
            .split('\n')
            .filter(line => !line.trim().startsWith('#'))
            .some(line => /git push|git commit|gh pr create/.test(line))
      );
      expect(pushers.length).toBeGreaterThan(0);
      for (const n of pushers) {
        expect(GATED, `${lane}: ${n.id} pushes, commits or opens a PR`).toContain(n.id);
      }
    });
  });
}

// On win32 `bash` may resolve to WSL; the suites run on POSIX CI (ubuntu-latest).
const SUITES = [
  'dprep-package-folder.sh',
  'trusted-final-dprep.sh',
  'implement-block-gate.sh',
  // Test 8: the existing suites that read these nodes still pass unchanged.
  'run-stop-tests.sh',
  'block-reclassify-rereview.sh',
  'trusted-test-infra-r2.sh',
  'trusted-test-infra-r3.sh',
  'test-repair-guard.sh',
  'assert-implement-deliverable-diff.sh',
];
describe.skipIf(process.platform === 'win32')('lane shell suites', () => {
  for (const suite of SUITES) {
    test(`${suite} passes with zero failures`, () => {
      const proc = Bun.spawnSync(['bash', join(defaultsDir, '__tests__', suite)], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const text = proc.stdout.toString();
      if (proc.exitCode !== 0) {
        throw new Error(`${suite} exited ${String(proc.exitCode)}\n${text.slice(-4000)}`);
      }
      expect(proc.exitCode).toBe(0);
    }, 900_000);
  }
});
