/**
 * canonical-stages.ts -- parity-locked port of the multi-stage lane's
 * parse-stages selection and the feature lane's rst_class token rule.
 *
 * The YAML heredoc remains the lane's executable parser. This module does not
 * replace it. Absent class does not default to CODE.
 */

const CLASS_LINE = /^[ \t]*(?:WO )?[Cc]lass:[ \t]*(CODE|INFRA|MIXED|DOCUMENTATION|DOCS|OPERATOR)\b/;

const FENCE_RE = /```ya?ml\s*\n([\s\S]*?)\n```/g;

const MARKERS: readonly RegExp[] = [
  /^\s*##+\s+Canonical\s+stages\b/im,
  /^\s*##+\s+Stages\b/im,
  /<!--\s*canonical-stages\s*-->/i,
  /<!--\s*stages:\s*canonical\s*-->/i,
];

const REQUIRED_STAGE_KEYS = [
  'id',
  'repo',
  'target_branch',
  'in_scope_files',
  'verify_commands',
  'readiness_bar',
] as const;

const READINESS_KEYS = ['pr_open', 'ci_green', 'diff_review_clean', 'mergeable'] as const;

const SELECTION_WINDOW = 600;

interface BunYaml {
  parse(input: string): unknown;
}

function parseYaml(text: string): unknown {
  const bunYaml = (Bun as unknown as { YAML?: BunYaml }).YAML;
  if (!bunYaml) {
    throw new Error('FAIL: YAML parser unavailable; cannot parse stages.');
  }
  try {
    return bunYaml.parse(text);
  } catch (error) {
    throw new Error(`FAIL: stages YAML parse error: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * First "WO Class:" / "Class:" token, matching rst_class without the CODE default.
 * Returns null when the spec does not declare a recognized class.
 */
export function readSpecClass(specText: string): string | null {
  for (const line of specText.split(/\r?\n/)) {
    const match = CLASS_LINE.exec(line);
    const token = match?.[1];
    if (!token) continue;
    if (token === 'DOCS') return 'DOCUMENTATION';
    return token;
  }
  return null;
}

function fencedCandidates(specText: string): { offset: number; body: string }[] {
  const candidates: { offset: number; body: string }[] = [];
  for (const match of specText.matchAll(FENCE_RE)) {
    const body = match[1] ?? '';
    const opensStages = body.split(/\r?\n/).some(line => line.startsWith('stages:'));
    if (!opensStages || match.index === undefined) continue;
    candidates.push({ offset: match.index, body });
  }
  return candidates;
}

function unfencedCandidate(specText: string): { offset: number; body: string } | null {
  const lines = specText.split(/\r?\n/);
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (!capturing) {
      if (line.startsWith('stages:')) {
        capturing = true;
        out.push(line);
      }
      continue;
    }
    if (line === '') {
      out.push(line);
      continue;
    }
    if (!(line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-'))) break;
    out.push(line);
  }
  if (out.length === 0) return null;
  return { offset: 0, body: out.join('\n') };
}

function selectStagesBlock(specText: string): string {
  let candidates = fencedCandidates(specText);
  if (candidates.length === 0) {
    const unfenced = unfencedCandidate(specText);
    candidates = unfenced ? [unfenced] : [];
  }
  if (candidates.length === 0) {
    throw new Error('FAIL: no `stages:` declaration found in spec.');
  }

  for (const marker of MARKERS) {
    for (const candidate of candidates) {
      const window = specText.slice(
        Math.max(0, candidate.offset - SELECTION_WINDOW),
        candidate.offset
      );
      if (marker.test(window)) return candidate.body;
    }
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only) throw new Error('FAIL: no `stages:` declaration found in spec.');
    return only.body;
  }

  throw new Error(
    `FAIL: ${String(candidates.length)} \`stages:\` blocks found but none is marked canonical. ` +
      "Add '<!-- canonical-stages -->' immediately before the declared executable block."
  );
}

/**
 * Select and validate the executable canonical stages block.
 * N=1 is valid. No stage defaults are applied.
 */
export function validateCanonicalStages(specText: string): { stageIds: string[] } {
  const chosen = selectStagesBlock(specText);
  if (chosen.trim().length === 0) {
    throw new Error('FAIL: extracted stages YAML is empty');
  }
  const data = parseYaml(chosen);
  const stages = isRecord(data) ? data.stages : undefined;
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('FAIL: parsed `stages` is not a non-empty list.');
  }

  const stageIds: string[] = [];
  for (let index = 0; index < stages.length; index += 1) {
    const stage: unknown = stages[index];
    if (!isRecord(stage)) {
      throw new Error(`FAIL: stage ${String(index)} is not a mapping.`);
    }
    for (const key of REQUIRED_STAGE_KEYS) {
      if (!(key in stage)) {
        throw new Error(`FAIL: stage ${String(index)} missing required key '${key}'.`);
      }
    }
    const commands = stage.verify_commands;
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new Error(`FAIL: stage ${String(index)} 'verify_commands' must be a non-empty list.`);
    }
    const readiness = stage.readiness_bar;
    if (!isRecord(readiness)) {
      throw new Error(`FAIL: stage ${String(index)} 'readiness_bar' must be a mapping.`);
    }
    for (const key of READINESS_KEYS) {
      if (!(key in readiness)) {
        throw new Error(`FAIL: stage ${String(index)} 'readiness_bar' missing key '${key}'.`);
      }
      if (readiness[key] !== true) {
        throw new Error(
          `FAIL: stage ${String(index)} 'readiness_bar.${key}' must be true (no soft gates).`
        );
      }
    }
    stageIds.push(String(stage.id));
  }

  return { stageIds };
}
