/**
 * bdc-harness PR 1609, App review 5981769635: a failed evidence-repair-verify
 * must never let a lane publish REVIEW or complete the run.
 *
 * For every lane that has an evidence-repair-verify node, every node that can
 * publish REVIEW or complete the run must depend on the verify outcome and be
 * gated by it:
 *   - a bash node exits 1 on an evidence-only repair whose receipt is not
 *     "state":"verified" (the guard the PR already uses), or
 *   - a node's `when` (the only gate a prompt node has) is false when verify
 *     failed, using the REAL condition evaluator. This is the App's exact case:
 *     manifest checks OK, verify failed, fallback publication still allowed.
 * Ordinary runs are unchanged: verify's "not_applicable" output still passes.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { evaluateCondition } from '../condition-evaluator';
import type { NodeOutput } from '../schemas';

const DEFAULTS = join(import.meta.dir, '..', '..', '..', '..', '.archon', 'workflows', 'defaults');
const VERIFY = 'evidence-repair-verify';
const FINAL = 'evidence-repair-final';

// Nodes that publish REVIEW or complete the run. The others that touch the
// review label only remove it or add status:blocked (claim-issue, blocked-issue,
// tests-blocked-report); patch-pr-body must run before verify, which consumes
// the published body.
const PUBLISHING = new Set([
  'flip-notion',
  'flip-notion-on-failure',
  'review-issue',
  'record-wo-completion-candidate',
  'blocked-terminal-gate',
]);

interface LaneNode {
  id: string;
  depends_on?: string[];
  when?: string;
  bash?: string;
  prompt?: string;
}

function bashGuard(node: LaneNode): boolean {
  const body = node.bash ?? '';
  const readsReceipt =
    body.includes(`ER_RECEIPT=$${VERIFY}.output`) || body.includes(`ER_RECEIPT=$${FINAL}.output`);
  // On an evidence-only repair whose receipt is not verified, the node stops
  // before acting: exit 1 (fail) or exit 0 (record nothing, as
  // record-wo-completion-candidate does).
  const guardBlock =
    /grep -q '\^BUILD_OUTCOME=EVIDENCE_ONLY_REPAIR\$'; then\s+if ! printf '%s' "\$ER_RECEIPT" \| grep -q '"state":"verified"'; then\s+echo [^\n]*\n\s+exit [01]\b/;
  return readsReceipt && guardBlock.test(body);
}

function outputsFor(when: string, verifyOutput: string, verifyState: NodeOutput['state']) {
  const outputs = new Map<string, NodeOutput>();
  for (const match of when.matchAll(/\$([a-z0-9-]+)\.output/g)) {
    if (match[1] !== VERIFY) outputs.set(match[1], { state: 'completed', output: 'OK' });
  }
  outputs.set(
    VERIFY,
    verifyState === 'failed'
      ? { state: 'failed', output: verifyOutput, error: 'operator_handoff' }
      : { state: verifyState, output: verifyOutput }
  );
  return outputs;
}

test('every REVIEW-publishing or completing node is gated by the evidence-repair-verify outcome', () => {
  const lanes = readdirSync(DEFAULTS).filter(name => name.endsWith('.yaml'));
  const failures: string[] = [];
  let checked = 0;
  let lanesWithVerify = 0;
  for (const lane of lanes) {
    const doc = parse(readFileSync(join(DEFAULTS, lane), 'utf8')) as { nodes?: LaneNode[] };
    const nodes = doc.nodes ?? [];
    if (!nodes.some(node => node.id === VERIFY)) continue;
    lanesWithVerify += 1;
    for (const node of nodes) {
      if (!PUBLISHING.has(node.id)) continue;
      checked += 1;
      const where = `${lane}:${node.id}`;
      const deps = node.depends_on ?? [];
      if (!deps.includes(VERIFY) && !deps.includes(FINAL)) {
        failures.push(`${where}: does not depend on ${VERIFY}`);
        continue;
      }
      if (bashGuard(node)) continue;
      if (!node.when) {
        failures.push(`${where}: no receipt guard and no when gate`);
        continue;
      }
      // The App's exact case: verify failed (no verified receipt), everything else OK.
      const failedVerify = evaluateCondition(
        node.when,
        outputsFor(
          node.when,
          '{"state":"unknown","operator_handoff":"evidence_repair_check_timeout"}',
          'failed'
        )
      );
      if (failedVerify.result) failures.push(`${where}: publishes when ${VERIFY} failed`);
      // No new behaviour: an ordinary run and a verified repair still publish.
      for (const state of ['not_applicable', 'verified']) {
        const ok = evaluateCondition(
          node.when,
          outputsFor(node.when, `{"state":"${state}"}`, 'completed')
        );
        if (!ok.result) failures.push(`${where}: blocked when ${VERIFY} state is ${state}`);
      }
    }
  }
  // WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01: the rebuilt bdc-feature-development.yaml removed the
  // evidence repair (its five steps); the other 12 lanes keep it unchanged.
  expect(lanesWithVerify).toBe(12);
  expect(checked).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});
