import { BOARD_PREFIX, SNIPPETS_PER_HIT, WIKI_PREFIX, WIKI_SEARCH_MAX } from '../constants';
import { ToolFailure } from '../errors';
import { scrub } from '../scrub';
import { lexicalTrackedPath, readTrackedFile, type TrackedTree } from '../tracked-tree';

export interface SearchHit {
  path: string;
  snippets: string[];
}

async function readIfTracked(
  root: string,
  tree: TrackedTree,
  relativePath: string,
  prefix: string
): Promise<string> {
  const lexical = lexicalTrackedPath(relativePath, prefix);
  if (lexical === null) {
    throw new ToolFailure('refused', 'path_refused');
  }
  if (!tree.has(lexical)) {
    throw new ToolFailure('refused', 'not_tracked');
  }
  return readTrackedFile(root, lexical);
}

export async function wikiRead(
  root: string,
  tree: TrackedTree,
  requestedPath: string
): Promise<{ path: string; text: string }> {
  const text = await readIfTracked(root, tree, requestedPath, WIKI_PREFIX);
  return { path: requestedPath, text };
}

export async function boardRecordRead(
  root: string,
  tree: TrackedTree,
  requestedPath: string
): Promise<{ path: string; text: string }> {
  const text = await readIfTracked(root, tree, requestedPath, BOARD_PREFIX);
  return { path: requestedPath, text };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) {
      return count;
    }
    count += 1;
    from = found + needle.length;
  }
  return count;
}

export async function searchTree(
  root: string,
  tree: TrackedTree,
  prefix: string,
  query: string,
  limit: number
): Promise<SearchHit[]> {
  await tree.refreshIfHeadChanged();
  const trimmed = query.trim();
  if (trimmed === '') {
    throw new ToolFailure('refused', 'query_required');
  }
  const terms = trimmed.split(/\s+/);
  const cap = Math.min(Math.max(limit, 1), WIKI_SEARCH_MAX);
  const ranked: { path: string; snippets: string[]; count: number }[] = [];
  for (const file of tree.list(prefix)) {
    let text: string;
    try {
      text = await readTrackedFile(root, file);
    } catch (error) {
      if (error instanceof ToolFailure && error.code === 'path_refused') {
        continue;
      }
      throw error;
    }
    const scrubbed = scrub(text);
    const haystack = scrubbed.toLowerCase();
    let total = 0;
    let matchedAll = true;
    for (const term of terms) {
      const needle = term.toLowerCase();
      const occurrences = countOccurrences(haystack, needle);
      if (occurrences === 0) {
        matchedAll = false;
        break;
      }
      total += occurrences;
    }
    if (!matchedAll) {
      continue;
    }
    const snippets = scrubbed
      .split('\n')
      .filter(line => {
        const lower = line.toLowerCase();
        return terms.some(term => lower.includes(term.toLowerCase()));
      })
      .slice(0, SNIPPETS_PER_HIT);
    if (snippets.length > 0) {
      ranked.push({ path: file, snippets, count: total });
    }
  }
  ranked.sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    if (left.path < right.path) {
      return -1;
    }
    if (left.path > right.path) {
      return 1;
    }
    return 0;
  });
  return ranked.slice(0, cap).map(hit => ({ path: hit.path, snippets: hit.snippets }));
}
