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

import { resolveEntryLane, DEFAULT_ENGINE_TO_LANE, UNREACHABLE_ENGINES } from './router-dispatcher';

// Hermetic fixture covers every scenario the suite asserts. Mirrors the
// production router.yaml shape: tiers{} + task_classes{} + defaults{}.
// Updated for WO-HARNESS-LAYER2-OPENROUTER-CHEAP-TIER-01: 6-tier structure
// (0-5) with tier "2" = openrouter-cheap inserted, haiku 2->3, workhorse 3->4,
// fable-opus 4->5. Task classes updated accordingly.
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
    name: openrouter-cheap
    engines:
      - glm-5.2
      - qwen3-coder
      - deepseek-v4-pro
  "3":
    name: haiku
    engines:
      - claude-haiku-api
  "4":
    name: workhorse-subscription
    engines:
      - sonnet-subscription
      - codex-subscription
  "5":
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
    starting_tier: "2"
    engine_hint: sonnet-subscription
  single-builder-pr:
    starting_tier: "2"
    engine_hint: codex-subscription
  spec-authoring:
    starting_tier: "5"
  architecture-review:
    starting_tier: "5"
  escalation-review:
    starting_tier: "5"
`;

const FIXTURE_OPTS = {
  routerYamlPath: '/fixture/router.yaml',
  routerYamlContent: FIXTURE_YAML,
};

describe('router-dispatcher resolveEntryLane', () => {
  it('T1: mechanical CODE class (build-code) resolves to Tier 2 + bdc-feature-development-glm lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'build-code',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });

    // build-code now starts at Tier 2 (openrouter-cheap). engine_hint
    // sonnet-subscription is not in Tier 2 engines so the hint is ignored;
    // first reachable engine is glm-5.2.
    expect(result.tier).toBe('2');
    expect(result.laneName).toBe('bdc-feature-development-glm');
    expect(result.engineHint).toBe('glm-5.2');
    // build-code starts at Tier 2 directly -- no skips.
    expect(result.skippedTiers).toEqual([]);
  });

  it('T2: single-builder-pr resolves to Tier 2 + bdc-feature-development-glm lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'single-builder-pr',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });

    // single-builder-pr now starts at Tier 2 (openrouter-cheap). engine_hint
    // codex-subscription is not in Tier 2 engines so the hint is ignored;
    // first reachable engine is glm-5.2.
    expect(result.tier).toBe('2');
    expect(result.laneName).toBe('bdc-feature-development-glm');
    expect(result.engineHint).toBe('glm-5.2');
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

  it('T4: unreachable Tier 1 (ollama-qwen3) is skipped to Tier 2 openrouter-cheap + glm lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'log-triage',
      woClass: 'INFRA',
      ...FIXTURE_OPTS,
    });

    // Tier 1 has ollama-qwen3 (UNREACHABLE) so it is skipped.
    // Tier 2 is openrouter-cheap; first engine glm-5.2 is reachable.
    expect(result.skippedTiers).toContain('1');
    expect(result.tier).toBe('2');
    expect(result.laneName).toBe('bdc-feature-development-glm');
    expect(result.engineHint).toBe('glm-5.2');
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
    // surface being touched. build-code now starts at Tier 2 (openrouter-cheap).
    const result = await resolveEntryLane({
      taskClass: 'build-code',
      ...FIXTURE_OPTS,
    });
    expect(result.laneName).toBe('bdc-feature-development-glm');
  });

  it('unknown task class falls back to fallback_tier defaults (no synthetic Tier 5 start)', async () => {
    const result = await resolveEntryLane({
      taskClass: 'never-heard-of-this-class',
      ...FIXTURE_OPTS,
    });

    // fallback_tier = "2" in the fixture, Tier 2 is openrouter-cheap (glm-5.2)
    // which is reachable -- the dispatcher should resolve there, not escalate to Tier 5.
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

  // ------------------------------------------------------------------
  // WO-HARNESS-LAYER2-OPENROUTER-CHEAP-TIER-01 -- Scenarios A through D
  // ------------------------------------------------------------------

  it('Scenario A: build-code resolves to openrouter-cheap tier (tier 2) after insertion', async () => {
    const result = await resolveEntryLane({
      taskClass: 'build-code',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });
    // build-code must now start at tier "2" (the new openrouter-cheap tier).
    // spec section 5 writes `result.tier === 2` (number) but ResolveResult.tier
    // is typed string; corrected here to '2'.
    expect(result.tier).toBe('2');
    expect(result.laneName).not.toBeNull();
    expect(result.laneName).not.toBe('');
  });

  it('Scenario B: DEFAULT_ENGINE_TO_LANE maps glm-5.2 to the OpenRouter lane', () => {
    expect(DEFAULT_ENGINE_TO_LANE['glm-5.2']).toBeDefined();
    expect(DEFAULT_ENGINE_TO_LANE['glm-5.2']).toBe('bdc-feature-development-glm');
  });

  it('Scenario C: DEFAULT_ENGINE_TO_LANE maps qwen3-coder and deepseek-v4-pro to the OpenRouter lane', () => {
    expect(DEFAULT_ENGINE_TO_LANE['qwen3-coder']).toBeDefined();
    expect(DEFAULT_ENGINE_TO_LANE['qwen3-coder']).toBe('bdc-feature-development-glm');
    expect(DEFAULT_ENGINE_TO_LANE['deepseek-v4-pro']).toBeDefined();
    expect(DEFAULT_ENGINE_TO_LANE['deepseek-v4-pro']).toBe('bdc-feature-development-glm');
  });

  it('Scenario D: ollama-qwen3 remains in UNREACHABLE_ENGINES', () => {
    expect(UNREACHABLE_ENGINES.has('ollama-qwen3')).toBe(true);
  });

  // ------------------------------------------------------------------
  // WO-HARNESS-LAYER2-OPENROUTER-CHEAP-TIER-01 -- New tier-5 classes
  // ------------------------------------------------------------------

  it('architecture-review resolves to Tier 5 (fable-opus) with null lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'architecture-review',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });
    // architecture-review starts at Tier 5. Tier 5 engines: fable-session, opus-api.
    // Neither has a lane wired in DEFAULT_ENGINE_TO_LANE (both are null).
    expect(result.tier).toBe('5');
    expect(result.engineHint).toBe('fable-session');
    expect(result.laneName).toBeNull();
    expect(result.skippedTiers).toEqual([]);
  });

  it('escalation-review resolves to Tier 5 (fable-opus) with null lane', async () => {
    const result = await resolveEntryLane({
      taskClass: 'escalation-review',
      woClass: 'CODE',
      ...FIXTURE_OPTS,
    });
    // escalation-review starts at Tier 5. Tier 5 engines: fable-session, opus-api.
    // Neither has a lane wired in DEFAULT_ENGINE_TO_LANE (both are null).
    expect(result.tier).toBe('5');
    expect(result.engineHint).toBe('fable-session');
    expect(result.laneName).toBeNull();
    expect(result.skippedTiers).toEqual([]);
  });
});
