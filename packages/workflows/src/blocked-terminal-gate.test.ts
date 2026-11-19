import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { substituteNodeOutputRefs } from './dag-executor';
import type { NodeOutput } from './schemas/workflow-run';

// WO-HARNESS-BLOCKED-BUILD-NOT-COMPLETED-01: a build that ended BLOCKED must not end the run
// as `completed`. Every bdc-feature-development lane that defines block-reclassify carries a
// terminal `blocked-terminal-gate` node that fails the run with `build_blocked: <status> <note>`.

const root = join(import.meta.dir, '../../..');
const defaultsDir = join(root, '.archon/workflows/defaults');
const GATE_ID = 'blocked-terminal-gate';
const BEGIN = '# ---- BEGIN blocked gate core';
const END = '# ---- END blocked gate core ----';

function laneFiles(): string[] {
  return readdirSync(defaultsDir)
    .filter(name => name.startsWith('bdc-feature-development') && name.endsWith('.yaml'))
    .filter(name => readFileSync(join(defaultsDir, name), 'utf8').includes('id: block-reclassify'))
    .sort();
}

interface LaneNode {
  id: string;
  depends_on?: string[];
  trigger_rule?: string;
  bash?: string;
}

// Plain YAML parse: the lane schema loader needs every provider registered, which is not what
// this guard is about.
function loadLane(file: string): { nodes: LaneNode[] } {
  const doc = parseYaml(readFileSync(join(defaultsDir, file), 'utf8')) as { nodes?: LaneNode[] };
  if (!Array.isArray(doc.nodes)) throw new Error(`${file}: no nodes`);
  return { nodes: doc.nodes };
}

function gateScript(file: string): string {
  const node = loadLane(file).nodes.find(candidate => candidate.id === GATE_ID);
  if (!node || typeof node.bash !== 'string') {
    throw new Error(`${file}: no bash ${GATE_ID} node`);
  }
  return node.bash;
}

function coreOf(script: string): string {
  const start = script.indexOf(BEGIN);
  const end = script.indexOf(END);
  if (start < 0 || end < 0) throw new Error('gate core markers missing');
  return script.slice(start, end + END.length);
}

function runGate(
  script: string,
  reclassify: string
): { code: number; stdout: string; stderr: string } {
  const outputs = new Map<string, NodeOutput>([
    ['block-reclassify', { state: 'completed', output: reclassify }],
  ]);
  const resolved = substituteNodeOutputRefs(script, outputs, true);
  const dir = mkdtempSync(join(tmpdir(), 'blocked-gate-'));
  try {
    const file = join(dir, 'gate.sh');
    writeFileSync(file, resolved, 'utf8');
    const proc = Bun.spawnSync(['bash', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      code: proc.exitCode ?? -1,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('blocked-terminal-gate', () => {
  test('Test 1: BLOCKED fails the run with a named reason', () => {
    const r = runGate(
      gateScript('bdc-feature-development-codex.yaml'),
      '{"status":"BLOCKED","note":"opus-made-changes-rereview-failed"}'
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('build_blocked: BLOCKED opus-made-changes-rereview-failed');
  });

  test('Test 1b: BLOCKED without a note and an unknown non-empty status still fail', () => {
    const script = gateScript('bdc-feature-development-codex.yaml');
    const noNote = runGate(script, '{"status":"BLOCKED"}');
    expect(noNote.code).toBe(1);
    expect(noNote.stderr).toContain('build_blocked: BLOCKED no-note');
    const unknown = runGate(script, '{"status":"HELD","note":"x"}');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('build_blocked: HELD x');
  });

  test('Test 2: PROCEED and ALREADY_SATISFIED pass, an absent block status does not fail the run', () => {
    const script = gateScript('bdc-feature-development-codex.yaml');
    for (const output of [
      '{"status":"PROCEED"}',
      '{"status":"PROCEED","note":"opus-repaired-and-rereviewed-satisfied"}',
      '{"status":"ALREADY_SATISFIED","note":"opus-confirmed-already-satisfied"}',
    ]) {
      const r = runGate(script, output);
      expect(r.code, output).toBe(0);
      expect(r.stderr, output).toBe('');
    }
    // block-reclassify never ran (an earlier gate skipped it): the run's own status stands
    const skipped = runGate(script, '');
    expect(skipped.code).toBe(0);
    expect(skipped.stderr).toBe('');
  });

  test('Test 3: every lane that defines block-reclassify carries the same gate after every terminal node', () => {
    const files = laneFiles();
    expect(files.length).toBeGreaterThanOrEqual(13);
    const cores = new Set<string>();
    for (const file of files) {
      const workflow = loadLane(file);
      const gate = workflow.nodes.find(candidate => candidate.id === GATE_ID);
      expect(gate, `${file}: ${GATE_ID}`).toBeDefined();
      expect(gate?.trigger_rule, `${file}:trigger_rule`).toBe('all_done');
      const referenced = new Set<string>();
      for (const node of workflow.nodes) {
        for (const dep of node.depends_on ?? []) referenced.add(dep);
      }
      const leaves = workflow.nodes
        .map(node => node.id)
        .filter(id => id !== GATE_ID && !referenced.has(id));
      const deps = gate?.depends_on ?? [];
      expect(deps, `${file}:depends_on has block-reclassify`).toContain('block-reclassify');
      for (const leaf of leaves) {
        expect(deps, `${file}: gate waits for terminal node ${leaf}`).toContain(leaf);
      }
      // nothing may depend on the gate: it is the end of the run
      expect(referenced.has(GATE_ID), `${file}: nothing depends on the gate`).toBe(false);
      cores.add(coreOf(gateScript(file)));
    }
    expect(cores.size, 'gate core is byte-identical across lanes').toBe(1);
  });
});
