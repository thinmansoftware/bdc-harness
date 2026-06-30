/**
 * Tests for the Cauldron 2.0 router-dispatcher.
 *
 * T1: mechanical CODE class resolves to its cheap entry tier/lane.
 * T2: codex engine_hint resolves to the codex lane.
 * T3: deterministic -- same input resolves to the same output every time.
 * T4: unreachable tier (ollama-qwen3) is skipped to the next plausible tier.
 * T5: no model/provider call is made in the resolve path (pure table lookup).
 *
 * Pattern mirrors condition-evaluator.test.ts -- mock @archon/paths BEFORE
 * importing the module under test so the cached logger picks up the mock.
 */
import { describe, it, expect, mock } from 'bun:test';

// --- Mock logger (MUST come before imports of modules under test) ---

const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// --- Imports (after mocks) ---

import { resolveEntryLane, resolveDispatchTarget } from './router-dispatcher';

// Hermetic fixture covers every scenario the suite asserts. Mirrors the
// production router.yaml shape: tiers{} + task_classes{} + defaults{}.
const FIXTURE_YAML = `version: 1
tiers:
  "0":
    name: script
    engines:
      - deterministic-script
  "1":
    name: qwen-local
    engines:
      - ollama-qwen3
  "2":
    name: haiku
    engines:
      - claude-haiku-api
  "3":
    name: workhorse-subscription
    engines:
      - sonnet-subscription
      - codex-subscription
  "4":
    name: fable-opus
    engines:
      - fable-session
      - opus-api
defaults:
  fallback_tier: "2"
task_classes:
  log-triage:
    starting_tier: "1"
  summarize:
    starting_tier: "1"
  build-code:
    starting_tier: "3"
    engine_hint: sonnet-subscription
  single-builder-pr:
    starting_tier: "3"
    engine_hint: codex-subscription
  spec-authoring:
    starting_tier: "4"
`;

const FIXTURE_OPTS = {
  routerYamlPath: '/fixture/router.yaml',
  routerYamlContent: FIXTURE_YAML,
};

describe('router-dispatcher resolveEntryLane', () => {
  it('T1: mechanical CODE class (build-code) resolves to Tier 3 + bdc-feature-development lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'build-code',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });

    expect(result.tier).toBe('3');
    expect(result.laneName).toBe('bdc-feature-development');
    expect(result.engineHint).toBe('sonnet-subscription');
    // build-code starts at Tier 3 directly -- no skips.
    expect(result.skippedTiers).toEqual([]);
  });

  it('T2: codex engine_hint (single-builder-pr) resolves to bdc-feature-development-codex lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'single-builder-pr',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });

    expect(result.tier).toBe('3');
    expect(result.laneName).toBe('bdc-feature-development-codex');
    expect(result.engineHint).toBe('codex-subscription');
  });

  it('T3: deterministic -- same input resolves to identical output every call', async () => {
    const a = await resolveEntryLane({
      taskClass: 'build-code',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });
    const b = await resolveEntryLane({
      taskClass: 'build-code',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });
    const c = await resolveEntryLane({
      taskClass: 'build-code',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
  });

  it('T4: unreachable Tier 1 (ollama-qwen3) is skipped to Tier 2 + glm lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'log-triage',
      woClass: 'INFRA',
      ...FIXTURE_OPTS,
    });

    expect(result.skippedTiers).toContain('1');
    expect(result.tier).toBe('2');
    expect(result.laneName).toBe('bdc-feature-development-glm');
    expect(result.engineHint).toBe('claude-haiku-api');
  });

  it('T5: resolve path is pure table lookup -- no provider/model symbols imported by the module', async () => {
    // The dispatcher module source is read at compile time. If any AI SDK or
    // provider abstraction were imported, the symbol names would appear in the
    // source. Read the module text and assert the forbidden symbols are absent.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(import.meta.dir, 'router-dispatcher.ts'), 'utf8');
    expect(src).not.toMatch(/IAgentProvider/);
    expect(src).not.toMatch(/sendQuery/);
    expect(src).not.toMatch(/ClaudeProvider/);
    expect(src).not.toMatch(/CodexProvider/);
    expect(src).not.toMatch(/getAgentProvider/);
    expect(src).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
    expect(src).not.toMatch(/@openai\/codex-sdk/);

    // And dynamic call is still pure -- runs to completion without any AI
    // surface being touched.
    const result = await resolveEntryLane({
      taskClass: 'build-code',
      ...FIXTURE_OPTS,
    });
    expect(result.laneName).toBe('bdc-feature-development');
  });

  it('unknown task class falls back to fallback_tier defaults (no synthetic Tier 4 start)', async () => {
    const result = await resolveEntryLane({
      taskClass: 'never-heard-of-this-class',
      ...FIXTURE_OPTS,
    });

    // fallback_tier = "2" in the fixture, Tier 2 has claude-haiku-api which is
    // reachable -- the dispatcher should resolve there, not escalate to Tier 4.
    expect(result.tier).toBe('2');
    expect(result.laneName).toBe('bdc-feature-development-glm');
  });

  it('empty taskClass also falls back to fallback_tier', async () => {
    const result = await resolveEntryLane({
      taskClass: '',
      ...FIXTURE_OPTS,
    });
    expect(result.tier).toBe('2');
  });

  it('Tier 0 (deterministic-script) yields null lane (script-only, no lane wired)', async () => {
    // No task_class maps to Tier 0 in the fixture; supply one inline.
    const yamlWithTier0Class = FIXTURE_YAML.replace(
      'task_classes:\n',
      'task_classes:\n  notion-flip:\n    starting_tier: "0"\n'
    );
    const result = await resolveEntryLane({
      taskClass: 'notion-flip',
      routerYamlPath: '/fixture/router.yaml',
      routerYamlContent: yamlWithTier0Class,
    });

    expect(result.tier).toBe('0');
    expect(result.engineHint).toBe('deterministic-script');
    expect(result.laneName).toBeNull();
  });
});

describe('resolveDispatchTarget -- Layer 2 fire path lane selection', () => {
  it('Scenario A -- task_class resolves to a lane and fires it', async () => {
    // Call resolveEntryLane directly to get the expected laneName, then assert
    // resolveDispatchTarget returns the same value for the same task_class.
    const expectedResolution = await resolveEntryLane({
      taskClass: 'build-code',
      ...FIXTURE_OPTS,
    });
    const result = await resolveDispatchTarget({
      taskClass: 'build-code',
      ...FIXTURE_OPTS,
    });
    // result must be defined, non-empty, and equal to what resolveEntryLane returned.
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result).toBe(expectedResolution.laneName);
    // Hardcoded anchor: FIXTURE_YAML maps build-code -> tier 3 -> sonnet-subscription
    // -> DEFAULT_ENGINE_TO_LANE['sonnet-subscription'] = 'bdc-feature-development'.
    expect(result).toBe('bdc-feature-development');
  });

  it('Scenario B -- explicit workflow name wins over task_class', async () => {
    const result = await resolveDispatchTarget({
      workflowName: 'bdc-feature-development',
      taskClass: 'build-code',
      ...FIXTURE_OPTS,
    });
    // Explicit name is highest precedence -- task_class resolution must NOT override it.
    expect(result).toBe('bdc-feature-development');
  });

  it('Scenario C -- unresolvable task_class falls back to explicit name, no exception', async () => {
    // unknown-class-xyz is not in FIXTURE_YAML task_classes. The explicit workflowName
    // takes highest precedence and is returned before resolveEntryLane is consulted,
    // so no exception is thrown regardless of task_class resolvability.
    const result = await resolveDispatchTarget({
      workflowName: 'bdc-feature-development',
      taskClass: 'unknown-class-xyz',
      ...FIXTURE_OPTS,
    });
    expect(result).toBe('bdc-feature-development');
  });
});
