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
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
  if (fails.length) { console.log(fails.join("; ")); }
' 2>&1 || true)
printf '%s' "$STRUCT_ERR"
`;

function runGate(yamlText: string, dir: string): { failed: boolean; detail: string } {
  const draftPath = join(dir, 'candidate.yaml.draft');
  writeFileSync(draftPath, yamlText, 'utf8');
  const result = Bun.spawnSync(['bash', '-c', STRUCTURAL_CHECK], {
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
  - id: decide
    prompt: |
      Emit SINGLE_DECISION_NEEDED=<one sentence John can answer> and a status.
  - id: flip-notion
    prompt: |
      Flip the WO to REVIEW.
`;

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
