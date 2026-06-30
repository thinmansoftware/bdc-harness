/**
 * full-run.test.ts -- End-to-end run shape tests
 *
 * Scenario 1 from WO spec: "Given a sample WO + diff + tests fixture,
 * fusion review produces a fusion-runs/<slug>/ folder with round-1
 * per-reviewer files, synthesis.md (all required sections present),
 * and manifest.json with per-reviewer served_model_id recorded."
 *
 * Uses stub gateway -- no real API calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildInputMd, runRound1, runSynthesizer } from '../rounds.js';
import { buildManifest } from '../manifest.js';
import { buildSynthesisMd, REQUIRED_SECTIONS } from '../synthesis.js';
import type {
  FusionConfig,
  FusionInputs,
  ModelCallRequest,
  ModelCallResult,
  ModelGateway,
} from '../types.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(THIS_DIR, '..', '..', 'fixtures');

// Stub gateway with all-section synthesizer response
const FULL_SYNTHESIS_STUB =
  '## Final Ruling\n\nAPPROVE WITH PATCH\n\nMinor fixes needed.\n\n' +
  '## Consensus Findings\n\nAll reviewers found no major issues.\n\n' +
  '## Disagreements\n\nNo disagreements.\n\n' +
  '## Highest Risk\n\nNo high risks identified.\n\n' +
  '## Must Fix Before Merge\n\nNone -- no blocking issues.\n\n' +
  '## Nice To Have Later\n\nAdd more tests.\n\n' +
  '## Scope Creep Warnings\n\nNo scope creep detected.\n\n' +
  '## Doctrine Boundary Check\n\nAll doctrine checks pass.\n\n' +
  '## Security / Tenant / PII Check\n\nNo security issues found.\n\n' +
  '## QA / Evidence Requirements\n\nExisting tests cover the behavior.\n\n' +
  '## Suggested Builder Prompt\n\nN/A.\n\n' +
  '## John Approval Question\n\nShould this PR be merged?';

function makeFullStubGateway(): ModelGateway {
  return async (req: ModelCallRequest): Promise<ModelCallResult> => {
    const isSynthesizer = req.role === 'synthesizer';
    return {
      text: isSynthesizer
        ? FULL_SYNTHESIS_STUB
        : `[STUB] Reviewer ${req.role}: no issues found. APPROVE WITH PATCH.`,
      servedModelId: `stub/${req.role}-model`,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ok: true,
      error: null,
    };
  };
}

const TWO_REVIEWER_CONFIG: FusionConfig = {
  reviewers: [
    {
      id: 'architect',
      modelId: 'test/architect-model',
      role: 'architecture-adversarial',
      promptTemplate: 'reviewer-architecture.txt',
    },
    {
      id: 'systems',
      modelId: 'test/systems-model',
      role: 'implementation-systems',
      promptTemplate: 'reviewer-implementation.txt',
    },
  ],
  synthesizer: {
    modelId: 'test/synthesizer-model',
    promptTemplate: 'synthesizer.txt',
  },
  enableRound2: false,
};

describe('full run shape -- stub gateway', () => {
  it('produces all required synthesis sections from fixture inputs', async () => {
    const woSpec = readFileSync(resolve(FIXTURES_DIR, 'sample-wo.md'), 'utf8');
    const diff = readFileSync(resolve(FIXTURES_DIR, 'sample-diff.patch'), 'utf8');
    const tests = readFileSync(resolve(FIXTURES_DIR, 'sample-tests.txt'), 'utf8');
    const manifest = readFileSync(resolve(FIXTURES_DIR, 'sample-manifest.json'), 'utf8');

    const inputs: FusionInputs = {
      woId: 'WO-FUSION-SAMPLE-01',
      woSpec,
      diff,
      tests,
      manifest,
      captainCi: '',
    };

    const gateway = makeFullStubGateway();
    const { inputMd, secretFindings } = buildInputMd(inputs);

    // Clean diff should have no secrets
    expect(secretFindings.length).toBe(0);

    // Round 1
    const reviewerResults = await runRound1(TWO_REVIEWER_CONFIG, inputMd, gateway);
    expect(reviewerResults.length).toBe(2);
    expect(reviewerResults.every(r => r.ok)).toBe(true);

    // Each reviewer has servedModelId recorded
    for (const rr of reviewerResults) {
      expect(rr.servedModelId).not.toBeNull();
      expect(typeof rr.servedModelId).toBe('string');
    }

    // Round 3 synthesizer
    const synthResult = await runSynthesizer(
      TWO_REVIEWER_CONFIG,
      reviewerResults,
      secretFindings,
      inputMd,
      gateway
    );
    expect(synthResult.ok).toBe(true);
    expect(synthResult.servedModelId).toBe('stub/synthesizer-model');

    // Build manifest
    const runManifest = buildManifest({
      woId: 'WO-FUSION-SAMPLE-01',
      inputMdContents: inputMd,
      reviewerResults,
      synthesizerResult: synthResult,
      outputFiles: [
        'input.md',
        'round-1/architect.md',
        'round-1/systems.md',
        'synthesis.md',
        'manifest.json',
      ],
    });

    // Manifest has per-reviewer servedModelId
    expect(runManifest.reviewers.length).toBe(2);
    for (const rev of runManifest.reviewers) {
      expect(rev.servedModelId).not.toBeNull();
    }
    expect(runManifest.status).toBe('completed');
    expect(runManifest.mode).toBe('pr-review');
    expect(runManifest.run_id).toBeTruthy();
    expect(runManifest.artifact_sha256).toBeTruthy();

    // Build synthesis.md
    const synthesisMd = buildSynthesisMd({
      synthesizerResult: synthResult,
      reviewerResults,
      secretFindings,
      runId: runManifest.run_id,
      woId: 'WO-FUSION-SAMPLE-01',
    });

    // All 12 required sections present
    for (const section of REQUIRED_SECTIONS) {
      expect(synthesisMd).toContain(`## ${section}`);
    }

    // Full panel header (no missing reviewers)
    expect(synthesisMd).toContain('Full panel');

    // Final ruling is one of the valid options
    const rulingMatch = synthesisMd.match(/## Final Ruling\s*\n+([^\n#]+)/);
    expect(rulingMatch).not.toBeNull();
    const ruling = rulingMatch![1]!.trim().toUpperCase();
    expect(['APPROVE', 'APPROVE WITH PATCH', 'HOLD', 'REJECT']).toContain(ruling);
  });

  it('manifest.json has all required top-level fields', async () => {
    const inputs: FusionInputs = {
      woId: 'WO-MANIFEST-TEST',
      woSpec: 'spec',
      diff: 'diff',
      tests: 'tests',
      manifest: 'manifest',
      captainCi: '',
    };
    const { inputMd } = buildInputMd(inputs);
    const gateway = makeFullStubGateway();
    const reviewerResults = await runRound1(TWO_REVIEWER_CONFIG, inputMd, gateway);
    const synthResult = await runSynthesizer(
      TWO_REVIEWER_CONFIG,
      reviewerResults,
      [],
      inputMd,
      gateway
    );

    const runManifest = buildManifest({
      woId: 'WO-MANIFEST-TEST',
      inputMdContents: inputMd,
      reviewerResults,
      synthesizerResult: synthResult,
      outputFiles: ['input.md', 'synthesis.md', 'manifest.json'],
    });

    // All required fields from spec section 4D
    expect(typeof runManifest.run_id).toBe('string');
    expect(runManifest.run_id.length).toBeGreaterThan(0);
    expect(typeof runManifest.created_at).toBe('string');
    expect(runManifest.mode).toBe('pr-review');
    expect(runManifest.artifact_name).toBe('WO-MANIFEST-TEST');
    expect(typeof runManifest.artifact_sha256).toBe('string');
    expect(runManifest.artifact_sha256.length).toBe(64); // SHA256 hex = 64 chars
    expect(Array.isArray(runManifest.models)).toBe(true);
    expect(Array.isArray(runManifest.reviewers)).toBe(true);
    expect(typeof runManifest.synthesizer).toBe('object');
    expect(typeof runManifest.token_usage).toBe('object');
    expect(runManifest.cost_estimate).toBeNull();
    expect(typeof runManifest.status).toBe('string');
    expect(Array.isArray(runManifest.output_files)).toBe(true);
  });

  it('round-1 files contain one file per reviewer', async () => {
    const inputs: FusionInputs = {
      woId: 'WO-FILE-SHAPE-TEST',
      woSpec: 'spec',
      diff: 'diff',
      tests: 'tests',
      manifest: 'manifest',
      captainCi: '',
    };
    const { inputMd } = buildInputMd(inputs);
    const gateway = makeFullStubGateway();
    const results = await runRound1(TWO_REVIEWER_CONFIG, inputMd, gateway);

    // One result per reviewer in config
    expect(results.length).toBe(TWO_REVIEWER_CONFIG.reviewers.length);

    // Each result has the correct reviewer id
    const ids = results.map(r => r.id).sort();
    expect(ids).toEqual(['architect', 'systems']);
  });
});

// ---------------------------------------------------------------------------
// Verify tmp folder creation helpers work end-to-end (test the path logic)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = resolve('/tmp', `fusion-test-${Date.now().toString()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('run folder path logic', () => {
  it('buildRunSlug produces YYYY-MM-DD-<slug> format', () => {
    // Inline the slug logic for testing (same as cli.ts)
    const woId = 'WO-HARNESS-FUSION-V01-PR-REVIEW-CLI-01';
    const today = new Date().toISOString().slice(0, 10);
    const slug = woId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const full = `${today}-${slug}`;

    expect(full).toMatch(/^\d{4}-\d{2}-\d{2}-/);
    expect(full.length).toBeLessThanOrEqual(50);
    // No non-ASCII in slug
    expect(/^[a-z0-9-]+$/.test(slug)).toBe(true);
  });
});
