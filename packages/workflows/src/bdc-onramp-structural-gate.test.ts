/**
 * Behavioral tests for the on-ramp atom structural placeholder gate.
 *
 * WO-CAULDRON-ONRAMP-ATOM-LASTMILE-FIXES-01 (Defect 6 / 6b / Finding-A)
 *
 * Tests the structural-validation bun logic used in bdc-harness-wo-onramp.yaml's
 * yaml-author loop until_bash and assert-yaml-ready nodes. The old gate banned bare
 * substrings ("one sentence", "{{", "}}", "template") that appear LEGITIMATELY in the
 * canonical base patterns and in healthy spec-fetching child YAMLs -- so it false-fired
 * on valid output. The fix parses the draft and validates FILLED STRUCTURAL POSITIONS
 * (root model, root name, inputs.WO_ID.default) plus an exact-match denylist of the
 * atom's own author-facing stub strings against TOP-LEVEL scalar values only -- it never
 * scans nodes[] or prompt: bodies (where legit <...> instruction tokens live).
 *
 * Architect verdict 2026-06-07: structural-position validation is the only design without
 * a false-positive ceiling against the canonical patterns. General ruling 2026-06-07 (A):
 * "must become structural/semantic, not a looser substring filter ... must explicitly pass
 * the canonical base pattern and spec-fetching child YAML that legitimately contain {{, }},
 * template, and the canonical sentence ... add regression tests showing both sides."
 *
 * Runs the real bun structural snippet via Bun.spawnSync against temp YAML fixtures, so no
 * mock.module() calls are needed -- safe in its own bun test invocation (no cross-file
 * pollution).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseWorkflow } from './loader';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

// The exact structural-check snippet embedded in bdc-harness-wo-onramp.yaml (both gates).
// Reads the draft path from $DRAFT, prints failures to stdout (empty = pass), exits 0.
// The caller treats non-empty stdout as a gate FAIL.
const STRUCTURAL_CHECK = `
STRUCT_ERR=$(DRAFT="$DRAFT" bun -e '
  const fs = require("fs");
  let obj;
  try { obj = Bun.YAML.parse(fs.readFileSync(process.env.DRAFT, "utf8")); }
  catch (e) { console.log("draft does not parse as YAML: " + e.message); process.exit(0); }
  if (obj === null || typeof obj !== "object") { console.log("draft is not a YAML mapping"); process.exit(0); }
  const fails = [];
  const model = obj.model;
  if (!model || !/^(sonnet|opus|haiku|claude-[A-Za-z0-9._-]+)$/.test(String(model))) {
    fails.push("root model: missing or not a real model (got: " + String(model) + ")");
  }
  const wid = obj && obj.inputs && obj.inputs.WO_ID ? obj.inputs.WO_ID.default : undefined;
  if (wid === undefined || wid === null) { fails.push("inputs.WO_ID.default missing"); }
  else if (String(wid).includes("<") || String(wid).includes("normalize-spec")) { fails.push("inputs.WO_ID.default unfilled stub: " + String(wid)); }
  const nm = obj.name;
  if (nm === undefined || nm === null) { fails.push("root name: missing"); }
  else if (String(nm).includes("<")) { fails.push("root name: unfilled stub: " + String(nm)); }
  const stubs = ["<WO_ID from normalize-spec>","<bdc-slug>","<bluedevilcollectibles/repo>","<one sentence, verbatim from spec>","<slug>","<WO_ID>","<true|false>"];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v === "object") continue;
    if (stubs.includes(String(v))) { fails.push("top-level field " + k + " unfilled stub: " + String(v)); }
  }
  const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const byId = new Map(nodes.map(node => [node && node.id, node]));
  const risk = byId.get("business-risk-gate");
  if (!risk || typeof risk !== "object") {
    fails.push("business-risk-gate missing");
  } else if (!String(risk.bash || "").includes(JSON.stringify({gate:"proceed"}))) {
    fails.push("business-risk-gate must emit gate=proceed only after its checks pass");
  }
  const ancestors = id => {
    const seen = new Set();
    const visit = current => {
      const node = byId.get(current);
      const deps = Array.isArray(node && node.depends_on) ? node.depends_on : [];
      for (const dep of deps) if (!seen.has(dep)) { seen.add(dep); visit(dep); }
    };
    visit(id);
    return seen;
  };
  const requiredWhen = "$" + "business-risk-gate.output.gate == " + String.fromCharCode(39) + "proceed" + String.fromCharCode(39);
  for (const id of ["decide-push-target", "commit-and-push", "open-pr-if-needed", "build-manifest", "flip-notion"]) {
    const node = byId.get(id);
    if (!node) { fails.push(id + " missing"); continue; }
    if (!ancestors(id).has("business-risk-gate")) fails.push(id + " is not downstream of business-risk-gate");
    if (String(node.when || "").trim() !== requiredWhen) {
      fails.push(id + " must condition on $" + "business-risk-gate.output.gate == proceed");
    }
  }
  if (fails.length) { console.log(fails.join("; ")); }
' 2>&1 || true)
printf '%s' "$STRUCT_ERR"
`;

function runGate(yamlText: string, dir: string): { failed: boolean; detail: string } {
  const draftPath = join(dir, 'candidate.yaml.draft');
  writeFileSync(draftPath, yamlText, 'utf8');
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';
  const result = Bun.spawnSync([bash, '-c', STRUCTURAL_CHECK], {
    cwd: dir,
    env: { ...process.env, DRAFT: draftPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = new TextDecoder().decode(result.stdout).trim();
  return { failed: out.length > 0, detail: out };
}

// A healthy child YAML that legitimately contains every token class the OLD gate
// false-fired on: "{{" Go-template, the word "template", and a "<... John can answer>"
// angle-bracket instruction inside a prompt body. All filled structural positions are real.
const HEALTHY_CHILD = `name: bdc-some-real-wo-01
description: A real child workflow.
model: sonnet
policyFile: harness/policies/agent-behavior.md
inputs:
  WO_ID:
    default: "WO-SOME-REAL-WO-01"
nodes:
  - id: fetch-spec
    bash: |
      SPEC=$(gh api "repos/bluedevilcollectibles/bdc-xo/contents/x.md" --template '{{.content}}' | base64 -d)
      echo "fetched from template"
  - id: business-risk-gate
    load_bearing: true
    bash: |
      echo "guard the invariant"
      echo '{"gate":"proceed"}'
  - id: decide-push-target
    depends_on: [business-risk-gate]
    when: "$business-risk-gate.output.gate == 'proceed'"
    prompt: |
      Emit SINGLE_DECISION_NEEDED=<one sentence John can answer> and a status.
  - id: commit-and-push
    depends_on: [decide-push-target]
    when: "$business-risk-gate.output.gate == 'proceed'"
    bash: echo push
  - id: open-pr-if-needed
    depends_on: [commit-and-push]
    when: "$business-risk-gate.output.gate == 'proceed'"
    bash: echo pr
  - id: build-manifest
    depends_on: [open-pr-if-needed]
    trigger_rule: all_done
    when: "$business-risk-gate.output.gate == 'proceed'"
    prompt: Build a truthful manifest.
  - id: flip-notion
    depends_on: [build-manifest]
    when: "$business-risk-gate.output.gate == 'proceed'"
    prompt: |
      Flip the WO to REVIEW.
`;

const BROKEN_UNGATED_SIDE_EFFECTS = HEALTHY_CHILD.replace(
  /\n    when: "\$business-risk-gate\.output\.gate == 'proceed'"/g,
  ''
);

const BROKEN_INVERTED_RISK_CONDITION = HEALTHY_CHILD.replace(
  /\$business-risk-gate\.output\.gate == 'proceed'/g,
  "$business-risk-gate.output.gate != 'proceed'"
);

// Same shape, but the agent forgot to substitute inputs.WO_ID.default -- the literal
// atom template stub survived. This is the real failure class the gate must catch.
const BROKEN_UNFILLED_WO_ID = HEALTHY_CHILD.replace(
  'default: "WO-SOME-REAL-WO-01"',
  'default: "<WO_ID from normalize-spec>"'
);

// Agent left the root name as a stub.
const BROKEN_UNFILLED_NAME = HEALTHY_CHILD.replace('name: bdc-some-real-wo-01', 'name: <slug>');

// Agent set a non-real model.
const BROKEN_BAD_MODEL = HEALTHY_CHILD.replace('model: sonnet', 'model: <model>');

describe('on-ramp atom structural placeholder gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'onramp-gate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('PASSES a healthy child containing {{, "template", and <...> instruction tokens', () => {
    const { failed, detail } = runGate(HEALTHY_CHILD, dir);
    expect(detail).toBe('');
    expect(failed).toBe(false);
  });

  it('loads the canonical parent workflow without treating child-only refs as parent deps', () => {
    const path = join(REPO_ROOT, '.archon/workflows/defaults/bdc-harness-wo-onramp.yaml');
    const result = parseWorkflow(readFileSync(path, 'utf8'), 'bdc-harness-wo-onramp.yaml');

    expect(result.error).toBeNull();
    expect(result.workflow?.name).toBe('bdc-harness-wo-onramp');
  });

  it('routes child dispatch and binding verification through the configured Archon API', () => {
    const path = join(REPO_ROOT, '.archon/workflows/defaults/bdc-harness-wo-onramp.yaml');
    const result = parseWorkflow(readFileSync(path, 'utf8'), 'bdc-harness-wo-onramp.yaml');
    const nodes = new Map(result.workflow?.nodes.map(node => [node.id, node]));
    const productionDefault = '${ARCHON_API_BASE:-https://archon.bluedevilcollectibles.com}';

    for (const id of ['fire-child', 'verify-binding']) {
      const bash = String(nodes.get(id)?.bash || '');
      expect(bash).toContain(productionDefault);
      expect(bash.replaceAll(productionDefault, '')).not.toContain(
        'https://archon.bluedevilcollectibles.com'
      );
    }
  });

  it('FAILS a draft with an unfilled inputs.WO_ID.default stub', () => {
    const { failed, detail } = runGate(BROKEN_UNFILLED_WO_ID, dir);
    expect(failed).toBe(true);
    expect(detail).toContain('inputs.WO_ID.default');
  });

  it('FAILS a draft with an unfilled root name stub', () => {
    const { failed, detail } = runGate(BROKEN_UNFILLED_NAME, dir);
    expect(failed).toBe(true);
    expect(detail).toContain('name');
  });

  it('FAILS a draft with a non-real root model', () => {
    const { failed, detail } = runGate(BROKEN_BAD_MODEL, dir);
    expect(failed).toBe(true);
    expect(detail).toContain('model');
  });

  it('FAILS malformed YAML', () => {
    const { failed, detail } = runGate('name: [unclosed\n  model: sonnet', dir);
    expect(failed).toBe(true);
    expect(detail).toContain('parse');
  });

  it('FAILS a child whose push, PR, and Notion nodes are not conditioned on risk PASS', () => {
    const { failed, detail } = runGate(BROKEN_UNGATED_SIDE_EFFECTS, dir);
    expect(failed).toBe(true);
    expect(detail).toContain('commit-and-push');
    expect(detail).toContain('open-pr-if-needed');
    expect(detail).toContain('build-manifest');
    expect(detail).toContain('flip-notion');
  });

  it('FAILS a child whose risk condition is inverted', () => {
    const { failed, detail } = runGate(BROKEN_INVERTED_RISK_CONDITION, dir);
    expect(failed).toBe(true);
    expect(detail).toContain('must condition');
  });

  it('keeps both real on-ramp validation gates in parity with the risk-chain check', () => {
    const source = readFileSync(
      join(REPO_ROOT, '.archon/workflows/defaults/bdc-harness-wo-onramp.yaml'),
      'utf8'
    );
    expect(
      source.match(/must condition on \$" \+ "business-risk-gate\.output\.gate == proceed/g)?.length
    ).toBe(2);
  });

  it('does NOT false-fire on a bare <one sentence> token inside a prompt body', () => {
    // The canonical base pattern contains a bare "<one sentence>" in a prompt body.
    // The structural gate must ignore prompt bodies entirely.
    const withBareToken = HEALTHY_CHILD.replace(
      'Emit SINGLE_DECISION_NEEDED=<one sentence John can answer> and a status.',
      'Emit REASON=<one sentence> on its own line.'
    );
    const { failed, detail } = runGate(withBareToken, dir);
    expect(detail).toBe('');
    expect(failed).toBe(false);
  });
});
