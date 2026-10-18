import { createHash } from 'node:crypto';

// Identity of the complete, source-owned CLI 0.153.3 Windows bundled entry.
// This authenticates fixture bytes only, not a Linux binary or provider account.
const SOURCE_FIXTURE_HASH = '59f2bbc19bce43c67d6f1cdd99886953a256d948788d85810c774b17375c1fb6';
const MAX_SOURCE_BYTES = 131072;

export interface RestrictedReviewCatalog {
  readonly catalogText: string;
  readonly sourceFixtureHash: string;
  readonly catalogHash: string;
}

/** Pure source preparation; does not establish effective tools or runtime admission. */
export function deriveRestrictedReviewCatalog(raw: Uint8Array): RestrictedReviewCatalog {
  if (!(raw instanceof Uint8Array)) throw new Error('review catalog requires bytes');
  if (raw.byteLength === 0 || raw.byteLength > MAX_SOURCE_BYTES) {
    throw new Error('review catalog source size rejected');
  }
  const bytes = Uint8Array.from(raw);
  const sourceFixtureHash = createHash('sha256').update(bytes).digest('hex');
  if (sourceFixtureHash !== SOURCE_FIXTURE_HASH) {
    throw new Error('review catalog source identity rejected');
  }
  // Only exact, reviewed source bytes reach the parser. Duplicate-key or other
  // reserializations fail identity; this is not a general JSON validation API.
  const catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  Object.assign(catalog.models[0], {
    shell_type: 'disabled',
    apply_patch_tool_type: null,
    tool_mode: 'direct',
    experimental_supported_tools: [],
    supports_search_tool: false,
  });
  const catalogText = JSON.stringify(catalog, null, 2) + '\n';
  return Object.freeze({
    catalogText,
    sourceFixtureHash,
    catalogHash: createHash('sha256').update(catalogText).digest('hex'),
  });
}
