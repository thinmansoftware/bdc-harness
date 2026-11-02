/**
 * rounds.ts -- Round-runner for Cauldron Fusion v0.1
 *
 * Implements:
 *   Round 1: Parallel independent reviewer fan-out (each reviewer blind to others)
 *   Round 2: Gated off in v0.1 (enableRound2: false in config)
 *   Round 3: Synthesizer produces the decision packet
 *
 * INTEGRITY guarantee: each reviewer result records which model ACTUALLY served
 * the response (servedModelId from gateway). A reviewer that errored or returned
 * empty is marked ok=false. The synthesizer is told about any MISSING reviewers
 * and instructed toward conservative rulings.
 *
 * SECRET BOUNDARY: redactSecrets() is applied to the diff before building any
 * prompt. Raw secrets NEVER reach the model gateway.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { redactSecrets } from './redact.js';
import type {
  FusionConfig,
  FusionInputs,
  ModelGateway,
  ReviewerConfig,
  ReviewerResult,
  SynthesizerResult,
} from './types.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(THIS_DIR, '..', 'prompts');

// ---------------------------------------------------------------------------
// Prompt template loading
// ---------------------------------------------------------------------------

function loadPromptTemplate(filename: string): string {
  const path = resolve(PROMPTS_DIR, filename);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Fusion: prompt template not found: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Input document assembly
// ---------------------------------------------------------------------------

/**
 * buildInputMd -- assemble the input.md document for a run.
 *
 * The diff is redacted before inclusion. Findings from redaction are returned
 * separately so they can be injected into the synthesizer prompt and synthesis.md.
 */
export function buildInputMd(inputs: FusionInputs): {
  inputMd: string;
  secretFindings: string[];
} {
  const { redacted: redactedDiff, findings: secretFindings } = redactSecrets(inputs.diff);

  const sections: string[] = [
    `# Fusion Input -- ${inputs.woId}`,
    '',
    '## Work Order Spec',
    inputs.woSpec,
    '',
    '## PR Diff (redacted)',
    '```diff',
    redactedDiff,
    '```',
    '',
    '## Tests Output',
    '```',
    inputs.tests,
    '```',
    '',
    '## Builder Manifest',
    '```',
    inputs.manifest,
    '```',
  ];

  if (inputs.captainCi.trim()) {
    sections.push('', '## Captain CI Output', '```', inputs.captainCi, '```');
  }

  return { inputMd: sections.join('\n'), secretFindings };
}

// ---------------------------------------------------------------------------
// Round 1: Independent reviewer fan-out
// ---------------------------------------------------------------------------

function buildReviewerPrompt(template: string, reviewer: ReviewerConfig, inputMd: string): string {
  return template
    .replace('{{REVIEWER_ROLE}}', reviewer.role)
    .replace('{{REVIEWER_ID}}', reviewer.id)
    .replace('{{INPUT_MD}}', inputMd);
}

/**
 * runRound1 -- fan out to all reviewers in parallel (blind, independent).
 *
 * Returns one ReviewerResult per reviewer. ok=false when the gateway returned
 * an error or empty text (INTEGRITY rule: never count a failed call as a vote).
 */
export async function runRound1(
  config: FusionConfig,
  inputMd: string,
  gateway: ModelGateway
): Promise<ReviewerResult[]> {
  const tasks = config.reviewers.map(async (reviewer): Promise<ReviewerResult> => {
    const templateText = loadPromptTemplate(reviewer.promptTemplate);
    const prompt = buildReviewerPrompt(templateText, reviewer, inputMd);

    const result = await gateway({
      role: reviewer.role,
      modelId: reviewer.modelId,
      prompt,
    });

    const ok = result.ok && result.text.trim().length > 0;
    return {
      id: reviewer.id,
      requestedModelId: reviewer.modelId,
      servedModelId: result.servedModelId,
      ok,
      error: ok ? null : (result.error ?? 'Empty response'),
      text: result.text,
      tokens: result.usage,
    };
  });

  return Promise.all(tasks);
}

// ---------------------------------------------------------------------------
// Round 3: Synthesizer
// ---------------------------------------------------------------------------

function buildSynthesizerPrompt(
  template: string,
  reviewerResults: ReviewerResult[],
  secretFindings: string[],
  inputMd: string
): string {
  const missingReviewers = reviewerResults.filter(r => !r.ok);
  const presentReviewers = reviewerResults.filter(r => r.ok);

  const reviewerSections = presentReviewers
    .map(
      r =>
        '### Reviewer: ' +
        r.id +
        ' (model: ' +
        r.requestedModelId +
        ')\n' +
        'Served model: ' +
        (r.servedModelId ?? 'unknown') +
        '\n\n' +
        r.text
    )
    .join('\n\n---\n\n');

  const missingNote =
    missingReviewers.length > 0
      ? '\n\n## MISSING REVIEWERS (INTEGRITY ALERT)\n' +
        'The following reviewers failed or returned empty output and are NOT counted:\n' +
        missingReviewers
          .map(r => '- ' + r.id + ' (' + r.requestedModelId + '): ' + (r.error ?? 'unknown error'))
          .join('\n') +
        '\n\nBecause the review panel is reduced, you MUST apply conservative bias.\n' +
        'Do NOT issue a bare "APPROVE" ruling. Use "APPROVE WITH PATCH", "HOLD", or "REJECT".'
      : '';

  const secretNote =
    secretFindings.length > 0
      ? '\n\n## SECRET BOUNDARY VIOLATIONS DETECTED\n' +
        secretFindings.map(f => '- ' + f).join('\n') +
        '\n\nThese items were REDACTED from the diff before review.\n' +
        'Flag them explicitly in the Security / Tenant / PII Check section.'
      : '';

  return template
    .replace('{{REVIEWER_SECTIONS}}', reviewerSections)
    .replace('{{MISSING_NOTE}}', missingNote)
    .replace('{{SECRET_NOTE}}', secretNote)
    .replace('{{INPUT_MD}}', inputMd);
}

/**
 * runSynthesizer -- produce the final decision packet.
 *
 * The synthesizer receives all round-1 outputs plus context about missing
 * reviewers and any secret findings. It must produce synthesis.md content.
 */
export async function runSynthesizer(
  config: FusionConfig,
  reviewerResults: ReviewerResult[],
  secretFindings: string[],
  inputMd: string,
  gateway: ModelGateway
): Promise<SynthesizerResult> {
  const template = loadPromptTemplate(config.synthesizer.promptTemplate);
  const prompt = buildSynthesizerPrompt(template, reviewerResults, secretFindings, inputMd);

  const result = await gateway({
    role: 'synthesizer',
    modelId: config.synthesizer.modelId,
    prompt,
  });

  return {
    modelId: config.synthesizer.modelId,
    servedModelId: result.servedModelId,
    ok: result.ok && result.text.trim().length > 0,
    text: result.text,
  };
}
