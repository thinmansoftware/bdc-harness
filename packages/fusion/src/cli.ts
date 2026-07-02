#!/usr/bin/env bun
/**
 * cli.ts -- Cauldron Fusion v0.1 CLI entrypoint
 *
 * Usage:
 *   fusion review \
 *     --wo <path-to-wo-spec.md> \
 *     --diff <path-or-> \
 *     --tests <path> \
 *     --manifest <path> \
 *     [--ci <path>] \
 *     [--config <path>] \
 *     [--out-dir <path>]
 *
 * ADVISORY ONLY: Fusion writes local files and prints to stdout.
 * It does NOT: edit repos, comment on GitHub, approve PRs, merge, or deploy.
 *
 * FUSION_STUB_GATEWAY=1 -- inject a stub gateway for smoke testing without API cost.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { callModel } from './gateway.js';
import { loadConfig } from './config.js';
import { buildInputMd, runRound1, runSynthesizer } from './rounds.js';
import { buildManifest } from './manifest.js';
import { buildSynthesisMd } from './synthesis.js';
import { isWoType, selectReviewers, assertReviewerDiversity, WO_TYPES } from './routing.js';
import type {
  FusionConfig,
  FusionInputs,
  ModelGateway,
  ModelCallRequest,
  ModelCallResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Stub gateway for smoke testing
// ---------------------------------------------------------------------------

const STUB_SYNTHESIS_TEMPLATE =
  '## Final Ruling\n\n' +
  'APPROVE WITH PATCH\n\n' +
  '[STUB] All reviewers returned stub responses. No real model called.\n\n' +
  '## Consensus Findings\n\n[STUB] No real findings.\n\n' +
  '## Disagreements\n\n[STUB] No disagreements.\n\n' +
  '## Highest Risk\n\n[STUB] No risks identified in stub mode.\n\n' +
  '## Must Fix Before Merge\n\n[STUB] No required fixes in stub mode.\n\n' +
  '## Nice To Have Later\n\n[STUB] No suggestions.\n\n' +
  '## Scope Creep Warnings\n\n[STUB] No scope creep detected.\n\n' +
  '## Doctrine Boundary Check\n\n[STUB] No doctrine violations detected.\n\n' +
  '## Security / Tenant / PII Check\n\n[STUB] No security issues in stub mode.\n\n' +
  '## QA / Evidence Requirements\n\n[STUB] No QA gaps identified.\n\n' +
  '## Suggested Builder Prompt\n\n[STUB] No builder prompt needed.\n\n' +
  '## John Approval Question\n\n[STUB] Is the stub output acceptable for testing purposes?\n';

function makeStubGateway(): ModelGateway {
  return async (req: ModelCallRequest): Promise<ModelCallResult> => {
    let text: string;
    if (req.role === 'synthesizer') {
      // Synthesizer stub includes all 12 required sections
      text = STUB_SYNTHESIS_TEMPLATE;
    } else {
      text =
        '[STUB] Reviewer ' +
        req.role +
        ' (model: ' +
        req.modelId +
        ') complete.\n' +
        'No issues found in stub mode. Recommended ruling: APPROVE WITH PATCH.\n\n' +
        'This is a stub response -- no real model was called.';
    }
    return {
      text,
      servedModelId: 'stub/stub-model',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ok: true,
      error: null,
    };
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string;
  wo?: string;
  diff?: string;
  tests?: string;
  manifest?: string;
  ci?: string;
  config?: string;
  woType?: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // remove 'bun' and script path

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = args[0] ?? '';
  const result: CliArgs = { command, outDir: './fusion-runs' };

  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1];

    switch (flag) {
      case '--wo':
        result.wo = next;
        i++;
        break;
      case '--diff':
        result.diff = next;
        i++;
        break;
      case '--tests':
        result.tests = next;
        i++;
        break;
      case '--manifest':
        result.manifest = next;
        i++;
        break;
      case '--ci':
        result.ci = next;
        i++;
        break;
      case '--config':
        result.config = next;
        i++;
        break;
      case '--wo-type':
        result.woType = next;
        i++;
        break;
      case '--out-dir':
        result.outDir = next ?? './fusion-runs';
        i++;
        break;
      default:
        console.error('Unknown flag: ' + (flag ?? ''));
        process.exit(1);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(
    'Cauldron Fusion v0.1 -- PR Review CLI\n' +
      '\n' +
      'ADVISORY ONLY: Writes local files. Does not merge, deploy, or edit repos.\n' +
      '\n' +
      'Usage:\n' +
      '  fusion review \\\n' +
      '    --wo <path-to-wo-spec.md> \\\n' +
      '    --diff <path-or-> \\\n' +
      '    --tests <path> \\\n' +
      '    --manifest <path> \\\n' +
      '    [--ci <path>] \\\n' +
      '    [--config <path>] \\\n' +
      '    [--wo-type <type>] \\\n' +
      '    [--out-dir <path>]\n' +
      '\n' +
      'Options:\n' +
      '  --wo       Path to WO spec markdown file\n' +
      '  --diff     Path to PR diff file, or - to read from stdin\n' +
      '  --tests    Path to test output file\n' +
      '  --manifest Path to builder manifest file\n' +
      '  --ci       Path to Captain CI output file (optional)\n' +
      '  --config   Path to fusion.config.json (default: package root)\n' +
      '  --wo-type  WO type for persona routing (optional; omit = full roster).\n' +
      '             One of: ' +
      WO_TYPES.join(', ') +
      '\n' +
      '  --out-dir  Output directory for run folder (default: ./fusion-runs)\n' +
      '\n' +
      'Environment:\n' +
      '  GLM_API_KEY          OpenRouter API key (required for real runs)\n' +
      '  FUSION_STUB_GATEWAY  Set to 1 to use a stub gateway (no API cost)\n'
  );
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

function readFile(path: string, label: string): string {
  try {
    return readFileSync(resolve(path), 'utf8');
  } catch {
    throw new Error('Failed to read ' + label + ' file: ' + path);
  }
}

async function readDiff(diffArg: string): Promise<string> {
  if (diffArg === '-') {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(diffArg, '--diff');
}

// ---------------------------------------------------------------------------
// Run folder helpers
// ---------------------------------------------------------------------------

function buildRunSlug(woId: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = woId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return today + '-' + slug;
}

function createRunFolder(outDir: string, slug: string): string {
  const runPath = resolve(outDir, slug);
  mkdirSync(resolve(runPath, 'round-1'), { recursive: true });
  return runPath;
}

function writeRunFile(runPath: string, relPath: string, content: string): void {
  const fullPath = resolve(runPath, relPath);
  writeFileSync(fullPath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Main review command
// ---------------------------------------------------------------------------

async function runReview(args: CliArgs): Promise<void> {
  // Validate required args
  const required: [string | undefined, string][] = [
    [args.wo, '--wo'],
    [args.diff, '--diff'],
    [args.tests, '--tests'],
    [args.manifest, '--manifest'],
  ];
  for (const [val, flag] of required) {
    if (!val) {
      console.error('Error: ' + flag + ' is required');
      process.exit(1);
    }
  }

  console.log('Cauldron Fusion v0.1 -- PR Review');
  console.log('ADVISORY ONLY -- no repo edits, no GitHub comments, no deploys\n');

  // Load config
  const config = loadConfig(args.config);
  console.log(
    'Config loaded: ' +
      config.reviewers.length.toString() +
      ' reviewer(s), synthesizer: ' +
      config.synthesizer.modelId
  );

  // Persona routing: when --wo-type is provided, filter the roster down to the
  // personas the Mode Matrix requires for that WO type (spec section 8). When it
  // is absent, the full configured roster runs (unchanged behavior).
  let runConfig: FusionConfig = config;
  if (args.woType !== undefined) {
    if (!isWoType(args.woType)) {
      console.error(
        'Error: unknown --wo-type "' + args.woType + '". Valid types: ' + WO_TYPES.join(', ')
      );
      process.exit(1);
    }
    const selected = selectReviewers(config.reviewers, args.woType);
    if (selected.length === 0) {
      console.error(
        'Error: WO type "' +
          args.woType +
          '" selected no configured reviewers. Check fusion.config.json roster.'
      );
      process.exit(1);
    }
    // Self-review guard (v1-scoped Test 7 proxy) -- throws (non-zero exit) if the
    // selection cannot support any cross-model review. Fail closed on purpose.
    assertReviewerDiversity(selected);
    runConfig = { ...config, reviewers: selected };
    console.log(
      'WO type "' +
        args.woType +
        '" -> ' +
        selected.length.toString() +
        ' persona(s): ' +
        selected.map(r => r.id).join(', ')
    );
  }

  // Select gateway
  const useStub = process.env.FUSION_STUB_GATEWAY === '1';
  const gateway: ModelGateway = useStub ? makeStubGateway() : callModel;
  if (useStub) {
    console.log('[STUB MODE] Using stub gateway -- no API calls will be made\n');
  }

  // Read inputs -- args already validated above, but need non-undefined values
  const woPath = args.wo ?? '';
  const diffArg = args.diff ?? '';
  const testsPath = args.tests ?? '';
  const manifestPath = args.manifest ?? '';

  const woId = woPath.split('/').pop()?.replace(/\.md$/, '') ?? 'unknown-wo';

  const woSpec = readFile(woPath, '--wo');
  const diff = await readDiff(diffArg);
  const tests = readFile(testsPath, '--tests');
  const manifest = readFile(manifestPath, '--manifest');
  const captainCi = args.ci ? readFile(args.ci, '--ci') : '';

  const inputs: FusionInputs = { woId, woSpec, diff, tests, manifest, captainCi };

  // Build input.md (applies secret redaction to diff)
  const { inputMd, secretFindings } = buildInputMd(inputs);
  if (secretFindings.length > 0) {
    console.log(
      '[SECRET BOUNDARY] ' +
        secretFindings.length.toString() +
        ' secret(s) redacted from diff before review:'
    );
    for (const f of secretFindings) {
      console.log('  - ' + f);
    }
    console.log('');
  }

  // Create run folder
  const slug = buildRunSlug(woId);
  const runPath = createRunFolder(args.outDir, slug);
  console.log('Run folder: ' + runPath + '\n');

  // Write input.md
  writeRunFile(runPath, 'input.md', inputMd);

  // Round 1: parallel reviewer fan-out
  console.log('Round 1: Sending to reviewers...');
  const reviewerResults = await runRound1(runConfig, inputMd, gateway);

  const outputFiles: string[] = ['input.md'];

  for (const rr of reviewerResults) {
    const filename = 'round-1/' + rr.id + '.md';
    const content = rr.ok
      ? rr.text
      : '[MISSING -- Reviewer ' + rr.id + ' failed]\n\nError: ' + (rr.error ?? 'unknown');
    writeRunFile(runPath, filename, content);
    outputFiles.push(filename);
    const status = rr.ok ? 'OK' : 'MISSING (' + (rr.error ?? 'unknown') + ')';
    const served = rr.servedModelId ?? 'unknown';
    console.log('  ' + rr.id + ': ' + status + ' | served: ' + served);
  }

  // Round 2: gated off in v0.1
  if (runConfig.enableRound2) {
    console.log('\nRound 2: (gated off in v0.1 config)\n');
  }

  // Round 3: synthesizer
  console.log('\nRound 3: Running synthesizer...');
  const synthesizerResult = await runSynthesizer(
    runConfig,
    reviewerResults,
    secretFindings,
    inputMd,
    gateway
  );

  const synthStatus = synthesizerResult.ok ? 'OK' : 'FAILED';
  const synthServed = synthesizerResult.servedModelId ?? 'unknown';
  console.log('  synthesizer: ' + synthStatus + ' | served: ' + synthServed);

  // Build synthesis.md
  const runManifest = buildManifest({
    woId,
    inputMdContents: inputMd,
    reviewerResults,
    synthesizerResult,
    outputFiles: [...outputFiles, 'synthesis.md', 'manifest.json'],
  });

  const synthesisMd = buildSynthesisMd({
    synthesizerResult,
    reviewerResults,
    secretFindings,
    runId: runManifest.run_id,
    woId,
  });

  writeRunFile(runPath, 'synthesis.md', synthesisMd);
  outputFiles.push('synthesis.md');

  // Write manifest.json
  writeRunFile(runPath, 'manifest.json', JSON.stringify(runManifest, null, 2));

  // Print summary
  const missingCount = reviewerResults.filter(r => !r.ok).length;
  console.log('\n--- Fusion Run Complete ---');
  console.log('Status: ' + runManifest.status);
  if (missingCount > 0) {
    console.log(
      '[!] ' + missingCount.toString() + ' reviewer(s) MISSING -- conservative ruling enforced'
    );
  }
  console.log('Output: ' + runPath);
  console.log('  input.md, round-1/, synthesis.md, manifest.json');
  console.log('\n[ADVISORY ONLY] Review synthesis.md and approve/reject manually.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.command === 'review') {
    await runReview(args);
  } else if (args.command === '--help' || args.command === '-h') {
    printHelp();
  } else {
    console.error('Unknown command: ' + args.command);
    console.error('Run with --help for usage.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[fusion] Fatal error: ' + msg);
  process.exit(1);
});
