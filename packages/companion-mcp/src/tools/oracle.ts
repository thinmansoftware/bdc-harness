import { readFile } from 'node:fs/promises';

import { ORACLE_TIMEOUT_MS } from '../constants';
import { ToolFailure } from '../errors';
import { scrub } from '../scrub';

const ORACLE_MAX_RESPONSE_BYTES = 256 * 1024;
const ORACLE_TEXT_CAP = 2000;
const ORACLE_TOP_K_DEFAULT = 5;
const ORACLE_TOP_K_MAX = 8;

export interface OracleHit {
  doc_title: string;
  doc_source: string;
  chunk_idx: number;
  score: number;
  text: string;
}

export function assertOracleSearchUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('oracle_url_refused');
  }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/v1/search') {
    throw new Error('oracle_url_refused');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('oracle_url_refused');
  }
  return parsed.href;
}

function clampTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isInteger(topK)) {
    return ORACLE_TOP_K_DEFAULT;
  }
  if (topK < 1) {
    return 1;
  }
  if (topK > ORACLE_TOP_K_MAX) {
    return ORACLE_TOP_K_MAX;
  }
  return topK;
}

async function readOracleKey(keyFile: string | undefined): Promise<string> {
  if (keyFile === undefined || keyFile.trim() === '') {
    throw new ToolFailure('refused', 'refused');
  }
  try {
    const value = (await readFile(keyFile, 'utf8')).trim();
    if (value.length === 0) {
      throw new ToolFailure('refused', 'refused');
    }
    return value;
  } catch (error) {
    if (error instanceof ToolFailure) {
      throw error;
    }
    throw new ToolFailure('refused', 'refused');
  }
}

function redactKey(value: string, key: string): string {
  if (key.length === 0) {
    return value;
  }
  return value.split(key).join('[REDACTED]');
}

function readHit(value: unknown, key: string): OracleHit {
  if (typeof value !== 'object' || value === null) {
    throw new ToolFailure('error', 'oracle_unavailable');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.doc_id !== 'string' ||
    typeof record.doc_title !== 'string' ||
    typeof record.doc_source !== 'string' ||
    typeof record.chunk_id !== 'string' ||
    typeof record.chunk_idx !== 'number' ||
    !Number.isInteger(record.chunk_idx) ||
    typeof record.text !== 'string' ||
    typeof record.score !== 'number' ||
    !Number.isFinite(record.score)
  ) {
    throw new ToolFailure('error', 'oracle_unavailable');
  }
  return {
    doc_title: redactKey(record.doc_title, key),
    doc_source: redactKey(record.doc_source, key),
    chunk_idx: record.chunk_idx,
    score: record.score,
    text: redactKey(scrub(record.text), key).slice(0, ORACLE_TEXT_CAP),
  };
}

function mapResults(payload: unknown, key: string): OracleHit[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new ToolFailure('error', 'oracle_unavailable');
  }
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results)) {
    throw new ToolFailure('error', 'oracle_unavailable');
  }
  return results.map(item => readHit(item, key));
}

async function readCappedText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    throw new ToolFailure('error', 'oracle_unavailable');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) {
        break;
      }
      total += step.value.byteLength;
      if (total > ORACLE_MAX_RESPONSE_BYTES) {
        throw new ToolFailure('error', 'oracle_unavailable');
      }
      chunks.push(step.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ToolFailure) {
      throw error;
    }
    throw new ToolFailure('error', 'oracle_unavailable');
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function oracleSearch(
  oracleUrl: string,
  keyFile: string | undefined,
  query: string,
  topK: number | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<{ results: OracleHit[] }> {
  if (query.trim() === '') {
    throw new ToolFailure('refused', 'query_required');
  }
  const key = await readOracleKey(keyFile);
  const clampedTopK = clampTopK(topK);
  const url = assertOracleSearchUrl(oracleUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ORACLE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify({ query, top_k: clampedTopK }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new ToolFailure('error', 'oracle_unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolFailure('error', 'oracle_unavailable');
    }
    const raw = await readCappedText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new ToolFailure('error', 'oracle_unavailable');
    }
    return { results: mapResults(payload, key) };
  } finally {
    clearTimeout(timer);
  }
}
