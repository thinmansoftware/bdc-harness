import { BOARD_PREFIX, SNIPPETS_PER_HIT, WIKI_PREFIX, WIKI_SEARCH_MAX } from '../constants';
import { ToolFailure } from '../errors';
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

export async function searchTree(
  root: string,
  tree: TrackedTree,
  prefix: string,
  query: string,
  limit: number
): Promise<SearchHit[]> {
  if (query.trim() === '') {
    throw new ToolFailure('refused', 'query_required');
  }
  const cap = Math.min(Math.max(limit, 1), WIKI_SEARCH_MAX);
  const hits: SearchHit[] = [];
  for (const file of tree.list(prefix)) {
    if (hits.length >= cap) {
      break;
    }
    let text: string;
    try {
      text = await readTrackedFile(root, file);
    } catch (error) {
      if (error instanceof ToolFailure && error.code === 'path_refused') {
        continue;
      }
      throw error;
    }
    const snippets = text
      .split('\n')
      .filter(line => line.includes(query))
      .slice(0, SNIPPETS_PER_HIT);
    if (snippets.length > 0) {
      hits.push({ path: file, snippets });
    }
  }
  return hits;
}
