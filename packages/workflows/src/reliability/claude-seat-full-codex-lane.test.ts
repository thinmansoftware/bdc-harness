/**
 * WO-HARNESS-CODEX-LANE-NO-CLAUDE-NODES-01: a Claude seat at the seven-day
 * cutoff must not refuse the Codex or Cursor lane.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { WorkflowConfig } from '../deps';
import { selectQuotaExhaustionRoute } from '../node-failover';
import type { WorkflowDefinition } from '../schemas';
import { resolveWorkflowNodeProviders } from './resolve-binding';
import {
  decideSeatGate,
  type SeatGateDecision,
  type SeatGateScope,
  type SeatId,
  type SeatReading,
  type SeatWindow,
} from './seat-usage';

const LANE_DIR = join(import.meta.dir, '..', '..', '..', '..', '.archon/workflows/defaults');
const RESETS_AT = '2026-11-01T00:00:00Z';
const CUTOFF_PERCENT = 95;

const EXPECTED_CODEX_MODELS: Readonly<Record<string, string>> = {
  'check-already-satisfied': 'gpt-6.1-terra',
  plan: 'gpt-6.1-terra',
  'apply-suggested-fix': 'gpt-6.1-sol',
  'decide-push-target': 'gpt-6.1-sol',
};

function windowReading(name: string, usedPercent: number): SeatWindow {
  return {
    name,
    used_percent: usedPercent,
    remaining_percent: 100 - usedPercent,
    resets_at: RESETS_AT,
  };
}

function measuredReading(
  seat: SeatId,
  windows: SeatWindow[],
  sevenDay: SeatReading['seven_day'],
  gateWindows: readonly string[]
): SeatReading {
  return {
    seat,
    limit_source: 'measured',
    windows,
    seven_day: sevenDay,
    gate_windows: [...gateWindows],
    note: '',
    probed_at: RESETS_AT,
    endpoint: 'https://example.invalid',
    limit_reached: false,
  };
}

const READINGS: Partial<Record<SeatId, SeatReading>> = {
  claude: measuredReading(
    'claude',
    [windowReading('five_hour', 10), windowReading('seven_day', 100)],
    { used_percent: 100, remaining_percent: 0, resets_at: RESETS_AT },
    ['five_hour', 'seven_day']
  ),
  codex: measuredReading(
    'codex',
    [windowReading('primary', 10), windowReading('secondary', 10)],
    'UNKNOWN',
    ['primary', 'secondary']
  ),
  cursor: measuredReading('cursor', [windowReading('monthly', 10)], 'NOT_APPLICABLE', ['monthly']),
};

function loadLane(fileName: string): WorkflowDefinition {
  const text = readFileSync(join(LANE_DIR, fileName), 'utf8');
  return Bun.YAML.parse(text) as WorkflowDefinition;
}

function emptyAssistantConfig(assistant: string): WorkflowConfig {
  return {
    assistant,
    commands: {},
    assistants: {
      claude: {},
      codex: {},
    },
  };
}

function gateLane(workflow: WorkflowDefinition): {
  decision: SeatGateDecision;
  resolved: ReturnType<typeof resolveWorkflowNodeProviders>;
} {
  const workflowProvider = workflow.provider;
  if (workflowProvider === undefined) {
    throw new Error(`workflow ${workflow.name} has no provider`);
  }
  const resolved = resolveWorkflowNodeProviders({
    workflow,
    workflowProvider,
    workflowModel: workflow.model,
    config: emptyAssistantConfig(workflowProvider),
  });
  const failoverDefaults = {
    failoverProvider: workflow.failover_provider,
    failoverModel: workflow.failover_model,
  };
  const scope: SeatGateScope = {
    laneProvider: workflowProvider,
    nodes: resolved.map(({ node, providerId }) => {
      const route = selectQuotaExhaustionRoute(providerId, node, failoverDefaults);
      return {
        nodeId: node.id,
        providerId,
        ...(route.kind === 'failover' ? { failoverProvider: route.provider } : {}),
      };
    }),
  };
  const bindings = resolved.map(({ providerId }) => ({ providerId }));
  return {
    decision: decideSeatGate(bindings, READINGS, CUTOFF_PERCENT, scope),
    resolved,
  };
}

test('claudeSeatFullCodexLaneRuns', () => {
  const codex = loadLane('bdc-feature-development-codex.yaml');
  const cursor = loadLane('bdc-feature-development-cursor.yaml');
  const codexGate = gateLane(codex);
  const cursorGate = gateLane(cursor);

  const claudeNodes = codexGate.resolved
    .filter(entry => entry.providerId === 'claude')
    .map(entry => entry.node.id);
  expect(claudeNodes).toEqual([]);

  for (const [nodeId, model] of Object.entries(EXPECTED_CODEX_MODELS)) {
    const entry = codexGate.resolved.find(item => item.node.id === nodeId);
    if (!entry) throw new Error(`missing resolved node ${nodeId}`);
    expect(entry.providerId).toBe('codex');
    expect(entry.node.model).toBe(model);
  }

  const manifest = codex.nodes.find(node => node.id === 'build-manifest');
  if (!manifest) throw new Error('missing build-manifest');
  // build-manifest keeps provider: codex with the Claude-free major-build-opr
  // persona (WO-HARNESS-NODE-USAGE-REFUSAL-FAILOVER-01); it carries no model pin.
  expect((manifest as { provider?: string }).provider).toBe('codex');
  expect(Object.hasOwn(manifest, 'model')).toBe(false);

  expect(codexGate.decision.refused).toBe(false);
  expect(cursorGate.decision.refused).toBe(false);
});
