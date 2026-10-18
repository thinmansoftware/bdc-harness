// Fixture-only preparation. No provider factory or runtime registration imports this module.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { restrictedClientOptions } from '../../packages/providers/src/codex/restricted-policy';
import { deriveRestrictedReviewCatalog } from '../../packages/providers/src/codex/restricted-review-catalog';

export const REVIEWER_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'view_image',
  'token_budget',
  'current_time_reminder',
  'sleep_tool',
  'deferred_executor',
  'request_permissions_tool',
  'image_generation',
  'tool_suggest',
  'deferred_tool_world_state',
  'recommended_plugins',
]);

export function fixtureClientOptions(): ReturnType<typeof restrictedClientOptions> {
  const base = restrictedClientOptions();
  return {
    ...base,
    config: {
      ...base.config,
      model_catalog_json: '/home/appuser/.codex/reviewer-models.json',
      tools: {
        update_plan: { enabled: false },
        experimental_request_user_input: { enabled: false },
      },
      features: {
        ...((base.config?.features ?? {}) as Record<string, boolean>),
        ...Object.fromEntries(REVIEWER_DISABLED_FEATURES.map(key => [key, false])),
      },
    },
  };
}

/** Bounded fixture-data JSON parser; duplicate decoded object keys are rejected. */
export function parseUniqueFixtureJson(raw: Uint8Array): unknown {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 1048576)
    throw new Error('fixture JSON byte bound');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(raw));
  let index = 0;
  let nodes = 0;
  const whitespace = (): void => {
    while (index < text.length && /[ \t\r\n]/.test(text[index])) index++;
  };
  function string(): string {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index++;
      else if (char === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new Error('fixture JSON unterminated string');
  }
  function value(depth: number): void {
    if (depth > 32 || ++nodes > 32768) throw new Error('fixture JSON structure bound');
    whitespace();
    const char = text[index];
    if (char === '"') {
      string();
    } else if (char === '{' || char === '[') {
      const object = char === '{';
      const end = object ? '}' : ']';
      const keys = new Set<string>();
      index++;
      whitespace();
      if (text[index] !== end) {
        for (;;) {
          if (object) {
            if (text[index] !== '"') throw new Error('fixture JSON key syntax');
            const key = string();
            if (keys.has(key)) throw new Error('fixture JSON duplicate key');
            keys.add(key);
            whitespace();
            if (text[index++] !== ':') throw new Error('fixture JSON colon syntax');
          }
          value(depth + 1);
          whitespace();
          if (text[index] !== ',') break;
          index++;
          whitespace();
        }
      }
      if (text[index++] !== end) throw new Error('fixture JSON closing syntax');
    } else {
      const token =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          text.slice(index)
        );
      if (!token) throw new Error('fixture JSON value syntax');
      index += token[0].length;
    }
  }
  value(0);
  whitespace();
  if (index !== text.length) throw new Error('fixture JSON trailing data');
  return JSON.parse(text);
}

export function compareBundledCatalog(
  installedRaw: Uint8Array,
  sourceRaw: Uint8Array
): ReturnType<typeof deriveRestrictedReviewCatalog> & { readonly installedOutputHash: string } {
  const derived = deriveRestrictedReviewCatalog(sourceRaw);
  const original = parseUniqueFixtureJson(sourceRaw) as { models: unknown[] };
  const installed = parseUniqueFixtureJson(installedRaw) as { models?: unknown[] } | null;
  if (
    !installed ||
    !Array.isArray(installed.models) ||
    installed.models.length > 64 ||
    installed.models.filter(
      model =>
        model !== null &&
        typeof model === 'object' &&
        'slug' in model &&
        model.slug === 'gpt-5.6-sol'
    ).length !== 1
  )
    throw new Error('installed model entry inventory rejected');
  const entry = installed.models.find(
    model =>
      model !== null && typeof model === 'object' && 'slug' in model && model.slug === 'gpt-5.6-sol'
  );
  if (!isDeepStrictEqual(entry, original.models[0]))
    throw new Error('installed model entry differs');
  return Object.freeze({
    ...derived,
    installedOutputHash: createHash('sha256').update(installedRaw).digest('hex'),
  });
}

export type ReviewerFixtureCase = 'positive' | 'shell' | 'patch' | 'code-mode';
export const REVIEWER_HOSTILE_CALL_ID = 'teetime-reviewer-hostile';
export const REVIEWER_FINAL_TEXT = '{"syntheticReviewer":"ready"}';

export function inspectReviewerRequest(
  raw: Uint8Array,
  requestNumber: number,
  caseName: ReviewerFixtureCase
): {
  bodyHash: string;
  instructionHash: string;
  inputHash: string;
  framingKeys: string[];
  decodedBytes: number;
  denialObserved: boolean;
} {
  if (
    !Number.isSafeInteger(requestNumber) ||
    requestNumber < 1 ||
    requestNumber > (caseName === 'positive' ? 1 : 2)
  )
    throw new Error('fixture request count');
  const value = parseUniqueFixtureJson(raw) as Record<string, unknown>;
  const allowedKeys = [
    'model',
    'instructions',
    'input',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'reasoning',
    'store',
    'stream',
    'stream_options',
    'include',
    'service_tier',
    'prompt_cache_key',
    'text',
    'client_metadata',
    'access_programs',
  ];
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowedKeys.includes(key))
  )
    throw new Error('fixture request framing');
  if (
    value.model !== 'gpt-5.6-sol' ||
    value.stream !== true ||
    typeof value.instructions !== 'string' ||
    !value.instructions.length
  )
    throw new Error('fixture model/instructions');
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length))
    throw new Error('fixture executable definitions');
  if (!Array.isArray(value.input)) throw new Error('fixture input inventory');
  for (const item of value.input) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('fixture input item');
    if (item.type === 'additional_tools') {
      if (!Array.isArray(item.tools) || item.tools.length)
        throw new Error('fixture additional tools');
    } else if (
      ![
        'message',
        'function_call',
        'function_call_output',
        'custom_tool_call',
        'custom_tool_call_output',
        'reasoning',
      ].includes(item.type)
    )
      throw new Error('fixture alternative definitions');
    if (requestNumber === 1 && !['message', 'additional_tools'].includes(item.type))
      throw new Error('fixture initial input effects');
  }
  let denialObserved = false;
  if (requestNumber === 2) {
    const name =
      caseName === 'shell' ? 'exec_command' : caseName === 'patch' ? 'apply_patch' : 'exec';
    const outputs = value.input.filter(
      item =>
        item.call_id === REVIEWER_HOSTILE_CALL_ID &&
        ['function_call_output', 'custom_tool_call_output'].includes(item.type)
    );
    if (
      outputs.length !== 1 ||
      typeof outputs[0].output !== 'string' ||
      ![
        'unsupported call: functions.' + name,
        'unsupported custom tool call: functions.' + name,
      ].includes(outputs[0].output)
    )
      throw new Error('fixture explicit denial required');
    denialObserved = true;
  }
  const digest = (bytes: string | Uint8Array): string =>
    createHash('sha256').update(bytes).digest('hex');
  return {
    bodyHash: digest(raw),
    instructionHash: digest(value.instructions),
    inputHash: digest(JSON.stringify(value.input)),
    framingKeys: Object.keys(value).sort(),
    decodedBytes: raw.byteLength,
    denialObserved,
  };
}

export function validateFixtureFinalText(text: unknown): void {
  if (text !== REVIEWER_FINAL_TEXT) throw new Error('fixture final bytes');
}

export function fixtureCaseAccepted(
  caseName: ReviewerFixtureCase,
  observation: {
    requests: number;
    hostileEmitted: boolean;
    denialObserved: boolean;
    rawToolEvent: boolean;
  }
): boolean {
  if (caseName === 'positive') {
    if (
      observation.requests !== 1 ||
      observation.hostileEmitted ||
      observation.denialObserved ||
      observation.rawToolEvent
    )
      throw new Error('fixture positive acceptance rejected');
    return true;
  }
  if (
    observation.requests !== 2 ||
    !observation.hostileEmitted ||
    !observation.denialObserved ||
    observation.rawToolEvent
  )
    throw new Error('fixture hostile acceptance rejected');
  return false;
}

function fixtureRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('fixture utility evidence object');
  return value as Record<string, unknown>;
}

/** ApiConfig.ToolsV2 omits native utility fields; require resolved CLI provenance. */
export function verifyReviewerUtilityControls(response: unknown): void {
  const result = fixtureRecord(response);
  if (!Array.isArray(result.layers) || result.layers.length > 16)
    throw new Error('fixture utility layer inventory');
  const layers = result.layers.map(fixtureRecord);
  const cliLayers = layers.filter(layer => fixtureRecord(layer.name).type === 'sessionFlags');
  if (cliLayers.length !== 1) throw new Error('fixture utility session layer count');
  const cli = cliLayers[0];
  const name = fixtureRecord(cli.name);
  if (
    Object.keys(name).length !== 1 ||
    (cli.disabledReason !== undefined && cli.disabledReason !== null) ||
    typeof cli.version !== 'string' ||
    cli.version.length === 0 ||
    cli.version.length > 256
  )
    throw new Error('fixture utility layer disabled or unversioned');
  const tools = fixtureRecord(fixtureRecord(cli.config).tools);
  const origins = fixtureRecord(result.origins);
  for (const key of ['update_plan', 'experimental_request_user_input']) {
    if (fixtureRecord(tools[key]).enabled !== false)
      throw new Error('fixture utility enabled or missing');
    const origin = fixtureRecord(origins['tools.' + key + '.enabled']);
    const originName = fixtureRecord(origin.name);
    if (
      originName.type !== 'sessionFlags' ||
      Object.keys(originName).length !== 1 ||
      origin.version !== cli.version ||
      Object.keys(origin).some(key => !['name', 'version'].includes(key))
    )
      throw new Error('fixture utility origin overridden or missing');
  }
}
