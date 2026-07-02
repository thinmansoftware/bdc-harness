/**
 * cli-routing.test.ts -- CLI wiring tests for --wo-type persona routing.
 *
 * WO-HARNESS-WAR-COUNCIL-PERSONA-ROSTER-01.
 *
 * The unit tests in routing.test.ts cover selectReviewers/assertReviewerDiversity
 * in isolation. This file covers the CLI glue in cli.ts:runReview() end to end by
 * spawning the actual CLI process with the stub gateway (no API cost):
 *
 *  - --wo-type narrows the configured roster to the Mode Matrix required set and
 *    only those personas run in Round 1 (spec section 8).
 *  - omitting --wo-type runs the full roster (unchanged behavior).
 *  - unknown --wo-type exits non-zero (error branch).
 *  - a WO type that resolves to zero configured reviewers exits non-zero.
 *  - a selection that collapses to a single shared model fails closed via the
 *    self-review guard (assertReviewerDiversity wired into the CLI).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(THIS_DIR, '..', '..');
const CLI = resolve(PKG_ROOT, 'src', 'cli.ts');
const DEFAULT_CONFIG = resolve(PKG_ROOT, 'fusion.config.json');
const FIXTURES_DIR = resolve(PKG_ROOT, 'fixtures');

const WO = resolve(FIXTURES_DIR, 'sample-wo.md');
const DIFF = resolve(FIXTURES_DIR, 'sample-diff.patch');
const TESTS = resolve(FIXTURES_DIR, 'sample-tests.txt');
const MANIFEST = resolve(FIXTURES_DIR, 'sample-manifest.json');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], outDir: string, configPath?: string): Promise<RunResult> {
  const fullArgs = [
    'review',
    '--wo',
    WO,
    '--diff',
    DIFF,
    '--tests',
    TESTS,
    '--manifest',
    MANIFEST,
    '--config',
    configPath ?? DEFAULT_CONFIG,
    '--out-dir',
    outDir,
    ...args,
  ];
  const proc = Bun.spawn(['bun', CLI, ...fullArgs], {
    cwd: PKG_ROOT,
    env: { ...process.env, FUSION_STUB_GATEWAY: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// Return the reviewer ids that produced a round-1/<id>.md file for the single run
// folder created under outDir.
function round1ReviewerIds(outDir: string): string[] {
  const runDirs = readdirSync(outDir, { withFileTypes: true }).filter(d => d.isDirectory());
  expect(runDirs.length).toBe(1);
  const runName = runDirs[0]!.name;
  const round1 = resolve(outDir, runName, 'round-1');
  return readdirSync(round1)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''))
    .sort();
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(resolve(tmpdir(), 'fusion-cli-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('cli --wo-type routing -- narrowing (spec section 8)', () => {
  it('narrows the roster to the harness-automation required set and only runs those personas', async () => {
    const { exitCode, stdout } = await runCli(['--wo-type', 'harness-automation'], outDir);

    expect(exitCode).toBe(0);
    // Narrowing announced with the resolved count and ids.
    expect(stdout).toContain('WO type "harness-automation" -> 4 persona(s)');
    // Round-1 files exist for exactly the 4 required personas -- no over-review.
    expect(round1ReviewerIds(outDir)).toEqual(
      ['architect', 'operator-friction', 'prior-art-scout', 'systems'].sort()
    );
  });

  it('does NOT run non-selected personas for a small mechanical bugfix', async () => {
    const { exitCode, stdout } = await runCli(['--wo-type', 'small-mechanical-bugfix'], outDir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('WO type "small-mechanical-bugfix" -> 1 persona(s)');
    // Only the adversarial analog (systems) resolves to a Round-1 reviewer.
    expect(round1ReviewerIds(outDir)).toEqual(['systems']);
  });

  it('runs the full configured roster when --wo-type is omitted (unchanged behavior)', async () => {
    const { exitCode, stdout } = await runCli([], outDir);

    expect(exitCode).toBe(0);
    // No narrowing line when the flag is absent.
    expect(stdout).not.toContain('persona(s):');
    // All 8 configured reviewers run.
    expect(round1ReviewerIds(outDir)).toEqual(
      [
        'architect',
        'buyer-critic',
        'contrarian',
        'operator-friction',
        'prior-art-scout',
        'product-advocate',
        'security-tenant-pii',
        'systems',
      ].sort()
    );
  });
});

describe('cli --wo-type routing -- error branches (process.exit(1))', () => {
  it('exits non-zero on an unknown --wo-type', async () => {
    const { exitCode, stderr } = await runCli(['--wo-type', 'not-a-real-type'], outDir);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown --wo-type');
    // No run folder should have been created.
    expect(readdirSync(outDir).length).toBe(0);
  });

  it('exits non-zero when a WO type resolves to zero configured reviewers', async () => {
    // Roster deliberately omits `systems`, the only Fusion-resolvable required
    // persona for small-mechanical-bugfix -> selectReviewers returns [].
    const cfgPath = resolve(outDir, 'no-systems.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        reviewers: [
          {
            id: 'architect',
            modelId: 'anthropic/claude-opus-4-5',
            role: 'architecture-adversarial',
            promptTemplate: 'reviewer-architecture.txt',
          },
        ],
        synthesizer: { modelId: 'openai/gpt-4.5', promptTemplate: 'synthesizer.txt' },
        enableRound2: false,
      }),
      'utf8'
    );

    const { exitCode, stderr } = await runCli(
      ['--wo-type', 'small-mechanical-bugfix'],
      outDir,
      cfgPath
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain('selected no configured reviewers');
  });

  it('fails closed when the selection collapses to a single shared model (self-review guard)', async () => {
    // harness-automation requires architect, operator-friction, systems, prior-art-scout.
    // All four share one model here -> no cross-model review is possible.
    const cfgPath = resolve(outDir, 'single-model.config.json');
    const oneModel = 'z-ai/glm-5.2';
    writeFileSync(
      cfgPath,
      JSON.stringify({
        reviewers: [
          {
            id: 'architect',
            modelId: oneModel,
            role: 'architecture-adversarial',
            promptTemplate: 'reviewer-architecture.txt',
          },
          {
            id: 'operator-friction',
            modelId: oneModel,
            role: 'operator-friction-critic',
            promptTemplate: 'reviewer-operator-friction.txt',
          },
          {
            id: 'systems',
            modelId: oneModel,
            role: 'implementation-systems',
            promptTemplate: 'reviewer-implementation.txt',
          },
          {
            id: 'prior-art-scout',
            modelId: oneModel,
            role: 'prior-art-scout',
            promptTemplate: 'reviewer-prior-art-scout.txt',
          },
        ],
        synthesizer: { modelId: 'openai/gpt-4.5', promptTemplate: 'synthesizer.txt' },
        enableRound2: false,
      }),
      'utf8'
    );

    const { exitCode, stderr } = await runCli(['--wo-type', 'harness-automation'], outDir, cfgPath);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/self-review guard/i);
  });
});

describe('cli --wo-type routing -- emergency-repair split (spec section 8 conditional)', () => {
  it('base emergency-repair narrows to just the adversarial analog (systems)', async () => {
    const { exitCode, stdout } = await runCli(['--wo-type', 'emergency-repair'], outDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('WO type "emergency-repair" -> 1 persona(s)');
    expect(round1ReviewerIds(outDir)).toEqual(['systems']);
  });

  it('emergency-repair-data adds Security/Tenant/PII (spec data/billing conditional)', async () => {
    // The default roster puts both `systems` and `security-tenant-pii` on
    // z-ai/glm-5.2. That correctly trips the self-review guard on the two-seat
    // selection (no cross-model review is possible), so this test uses a
    // config where the two selected seats have distinct models.
    const cfgPath = resolve(outDir, 'er-data.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        reviewers: [
          {
            id: 'systems',
            modelId: 'z-ai/glm-5.2',
            role: 'implementation-systems',
            promptTemplate: 'reviewer-implementation.txt',
          },
          {
            id: 'security-tenant-pii',
            modelId: 'anthropic/claude-opus-4-5',
            role: 'security-tenant-pii-critic',
            promptTemplate: 'reviewer-security-tenant-pii.txt',
          },
        ],
        synthesizer: { modelId: 'openai/gpt-4.5', promptTemplate: 'synthesizer.txt' },
        enableRound2: false,
      }),
      'utf8'
    );

    const { exitCode, stdout } = await runCli(
      ['--wo-type', 'emergency-repair-data'],
      outDir,
      cfgPath
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('WO type "emergency-repair-data" -> 2 persona(s)');
    expect(round1ReviewerIds(outDir)).toEqual(['security-tenant-pii', 'systems'].sort());
  });

  it('emergency-repair-data fails closed when both required seats share a model (self-review guard)', async () => {
    // The default roster puts systems and security-tenant-pii both on
    // z-ai/glm-5.2, so no cross-model review is possible; the guard must fire.
    const { exitCode, stderr } = await runCli(['--wo-type', 'emergency-repair-data'], outDir);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/self-review guard/i);
  });
});

describe('cli --builder-model self-review guard (closes single-reviewer gap)', () => {
  it('fails closed when --builder-model matches the sole selected reviewer', async () => {
    // small-mechanical-bugfix collapses to just `systems` (modelId z-ai/glm-5.2).
    // If the builder ran that same model, the guard must fire on 1 reviewer.
    const { exitCode, stderr } = await runCli(
      ['--wo-type', 'small-mechanical-bugfix', '--builder-model', 'z-ai/glm-5.2'],
      outDir
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/self-review guard/i);
  });

  it('fails closed when --builder-model matches ANY selected reviewer in a multi-reviewer set', async () => {
    const { exitCode, stderr } = await runCli(
      ['--wo-type', 'harness-automation', '--builder-model', 'z-ai/glm-5.2'],
      outDir
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/self-review guard/i);
  });

  it('passes when --builder-model is a model no reviewer uses', async () => {
    const { exitCode, stdout } = await runCli(
      ['--wo-type', 'harness-automation', '--builder-model', 'openai/nobody-here'],
      outDir
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('WO type "harness-automation" -> 4 persona(s)');
  });
});

describe('cli persona mapping is driven by fusion.config.json', () => {
  it('honors an operator-supplied personaMapping override from config', async () => {
    // Override remaps "Adversarial Reviewer" onto `contrarian`. small-mechanical-bugfix
    // should now resolve to `contrarian`, not `systems`.
    const cfgPath = resolve(outDir, 'override.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        reviewers: [
          {
            id: 'systems',
            modelId: 'z-ai/glm-5.2',
            role: 'implementation-systems',
            promptTemplate: 'reviewer-implementation.txt',
          },
          {
            id: 'contrarian',
            modelId: 'anthropic/claude-opus-4-5',
            role: 'contrarian-kill-switch',
            promptTemplate: 'reviewer-contrarian.txt',
          },
        ],
        synthesizer: { modelId: 'openai/gpt-4.5', promptTemplate: 'synthesizer.txt' },
        enableRound2: false,
        personaMapping: {
          Architect: 'architect',
          'Adversarial Reviewer': 'contrarian',
          'Product/User Advocate': 'product-advocate',
          'Contrarian / Kill-Switch Critic': 'contrarian',
          'Prior-Art Scout': 'prior-art-scout',
          'Buyer / Money Critic': 'buyer-critic',
          'Operator Friction Critic': 'operator-friction',
          'Security/Tenant/PII Critic': 'security-tenant-pii',
          'Doctrine Reviewer': null,
          'CI Validator': null,
          Synthesizer: null,
        },
      }),
      'utf8'
    );

    const { exitCode, stdout } = await runCli(
      ['--wo-type', 'small-mechanical-bugfix'],
      outDir,
      cfgPath
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('WO type "small-mechanical-bugfix" -> 1 persona(s)');
    expect(round1ReviewerIds(outDir)).toEqual(['contrarian']);
  });
});
