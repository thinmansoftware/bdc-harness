// Closed diagnostics only. No raw text, caller identifiers or authority escapes.
export interface SdkStartupEvidence {
  readonly stderrBytes: number;
  readonly classificationLimited: boolean;
  readonly startupStages: readonly string[];
  readonly causeCategories: readonly string[];
  readonly osErrnos: readonly number[];
}

export interface SdkFailureEvidence {
  readonly version: 1;
  readonly kind: 'cli-exit' | 'sdk-parse' | 'aborted' | 'other';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrCategory: string;
  readonly startupEvidence: SdkStartupEvidence | null;
}

// Source-derived classifications previously used by the credential-free reviewer
// fixture. Arrays and objects are immutable so later enrichment cannot alter them.
export function inspectSdkStartupStderr(raw: string): SdkStartupEvidence {
  const stderrBytes = Buffer.byteLength(raw);
  const classificationLimited = stderrBytes > 65536;
  const sample = classificationLimited ? raw.slice(0, 8191) + '\n' + raw.slice(-8191) : raw;
  const prefixes: Record<string, string> = {
    'Error parsing -c overrides:': 'config-overrides',
    'Error finding codex home:': 'codex-home',
    'Error loading rules:': 'exec-policy',
    'Error loading config.toml:': 'config-load',
    'failed to initialize in-process app-server client:': 'app-server-start',
    'thread/start:': 'thread-start',
    'failed to parse model_catalog_json path `': 'model-catalog',
  };
  const found = new Set<string>();
  for (const rawLine of sample.split(/\r?\n/)) {
    const line = rawLine.startsWith('Error: ') ? rawLine.slice(7) : rawLine;
    for (const [prefix, stage] of Object.entries(prefixes))
      if (line.startsWith(prefix)) found.add(stage);
  }
  const startupStages = Object.values(prefixes).filter(stage => found.has(stage));
  const osErrnos = [2, 11, 13, 24, 28, 30].filter(code => sample.includes('(os error ' + code + ')'));
  const causeCategories: string[] = [];
  if (sample.includes('failed to parse model_catalog_json path `')) causeCategories.push('model-catalog-json');
  if (sample.includes('API key auth is missing a key.')) causeCategories.push('auth-key-missing');
  if (osErrnos.length) causeCategories.push('os-error');
  return Object.freeze({stderrBytes, classificationLimited,
    startupStages: Object.freeze(startupStages.length ? startupStages : ['other']),
    causeCategories: Object.freeze(causeCategories.length ? causeCategories : ['other']),
    osErrnos: Object.freeze(osErrnos)});
}

function dataString(value: unknown, key: 'name' | 'message'): string {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return '';
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : '';
  } catch { return ''; }
}

export function inspectSdkFailureEvidence(error: unknown): Readonly<SdkFailureEvidence> {
  // Getter-only or inherited names remain unknown; abort recognition is partial.
  const message = dataString(error, 'message');
  const result: SdkFailureEvidence = {version: 1, kind: 'other', exitCode: null,
    signal: null, stderrCategory: 'other', startupEvidence: null};
  if (dataString(error, 'name') === 'AbortError') return Object.freeze({...result, kind: 'aborted'});
  const exit = /^Codex Exec exited with (?:code ([0-9]{1,3})|signal (SIGTERM|SIGKILL|SIGABRT|SIGSEGV|SIGINT|SIGPIPE|SIGBUS|SIGILL)): /.exec(message.slice(0, 100));
  if (exit && (exit[1] === undefined || Number(exit[1]) <= 255)) {
    const startupEvidence = inspectSdkStartupStderr(message.slice(exit[0].length));
    const stages = startupEvidence.startupStages;
    const category = stages.length === 1 && ['config-overrides', 'codex-home', 'exec-policy',
      'config-load', 'app-server-start'].includes(stages[0]!) ? stages[0]! : 'other';
    return Object.freeze({...result, kind: 'cli-exit', exitCode: exit[1] === undefined ? null : Number(exit[1]),
      signal: exit[2] ?? null, stderrCategory: category, startupEvidence});
  }
  return Object.freeze({...result, kind: message.startsWith('Failed to parse item: ') ? 'sdk-parse' : 'other'});
}
