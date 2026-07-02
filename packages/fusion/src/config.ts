/**
 * config.ts -- Load and validate fusion.config.json
 *
 * Default config path is resolved relative to this file's directory
 * (i.e., <package-root>/fusion.config.json). Pass an explicit path via --config.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { FusionConfig, PersonaMapping, ReviewerConfig, SynthesizerConfig } from './types.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = resolve(THIS_DIR, '..', 'fusion.config.json');

/**
 * loadConfig -- read and parse fusion.config.json.
 *
 * Throws a descriptive error on missing or malformed config.
 */
export function loadConfig(configPath?: string): FusionConfig {
  const resolved = configPath ?? DEFAULT_CONFIG_PATH;
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(
      'fusion.config.json not found at: ' +
        resolved +
        '\n' +
        'Copy packages/fusion/fusion.config.json to the expected path or pass --config.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('fusion.config.json is not valid JSON: ' + resolved);
  }

  return validateConfig(parsed);
}

// Typed accessor helpers that avoid bracket-notation lint errors.
// We cast to Record<string, unknown> and then use dot notation accessors.

interface RawConfigShape {
  reviewers?: unknown;
  synthesizer?: unknown;
  enableRound2?: unknown;
  personaMapping?: unknown;
}

interface RawReviewerShape {
  id?: unknown;
  modelId?: unknown;
  role?: unknown;
  promptTemplate?: unknown;
}

interface RawSynthesizerShape {
  modelId?: unknown;
  promptTemplate?: unknown;
}

function validateConfig(raw: unknown): FusionConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('fusion.config.json: root must be an object');
  }

  const obj = raw as RawConfigShape;

  if (!Array.isArray(obj.reviewers)) {
    throw new Error('fusion.config.json: "reviewers" must be an array');
  }
  if (typeof obj.synthesizer !== 'object' || obj.synthesizer === null) {
    throw new Error('fusion.config.json: "synthesizer" must be an object');
  }

  const reviewers: ReviewerConfig[] = (obj.reviewers as unknown[]).map((r, i) =>
    validateReviewer(r, i)
  );
  const synthesizer: SynthesizerConfig = validateSynthesizer(obj.synthesizer);
  const enableRound2 = typeof obj.enableRound2 === 'boolean' ? obj.enableRound2 : false;
  const personaMapping = validatePersonaMapping(obj.personaMapping);

  const cfg: FusionConfig = { reviewers, synthesizer, enableRound2 };
  if (personaMapping !== undefined) {
    cfg.personaMapping = personaMapping;
  }
  return cfg;
}

/**
 * Optional block: fusion.config.json may declare an explicit
 * `personaMapping` object mapping Mode-Matrix persona labels (e.g.
 * "Adversarial Reviewer") to concrete reviewer.id strings (or null for
 * symbolic-only seats satisfied outside Fusion). When present, this
 * overrides the code-level default map in routing.ts. Missing = fall back
 * to the code default.
 */
function validatePersonaMapping(raw: unknown): PersonaMapping | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'fusion.config.json: personaMapping must be an object of label -> reviewerId|null'
    );
  }
  const out: PersonaMapping = {};
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      out[label] = null;
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        'fusion.config.json: personaMapping["' + label + '"] must be a non-empty string or null'
      );
    }
    out[label] = value;
  }
  return out;
}

function validateReviewer(r: unknown, idx: number): ReviewerConfig {
  if (typeof r !== 'object' || r === null) {
    throw new Error('fusion.config.json: reviewers[' + idx.toString() + '] must be an object');
  }
  const obj = r as RawReviewerShape;
  assertString(obj.id, 'reviewers[' + idx.toString() + '].id');
  assertString(obj.modelId, 'reviewers[' + idx.toString() + '].modelId');
  assertString(obj.role, 'reviewers[' + idx.toString() + '].role');
  assertString(obj.promptTemplate, 'reviewers[' + idx.toString() + '].promptTemplate');
  return {
    id: obj.id as string,
    modelId: obj.modelId as string,
    role: obj.role as string,
    promptTemplate: obj.promptTemplate as string,
  };
}

function validateSynthesizer(s: unknown): SynthesizerConfig {
  if (typeof s !== 'object' || s === null) {
    throw new Error('fusion.config.json: synthesizer must be an object');
  }
  const obj = s as RawSynthesizerShape;
  assertString(obj.modelId, 'synthesizer.modelId');
  assertString(obj.promptTemplate, 'synthesizer.promptTemplate');
  return {
    modelId: obj.modelId as string,
    promptTemplate: obj.promptTemplate as string,
  };
}

function assertString(val: unknown, context: string): void {
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error('fusion.config.json: ' + context + ' must be a non-empty string');
  }
}
