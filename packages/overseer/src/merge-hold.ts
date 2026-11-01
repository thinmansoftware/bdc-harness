const BDC_OWNER = 'thinmansoftware';
const BDC_XO_REPO = 'bdc-xo';
const BDC_XO_REF = 'main';

interface GitHubContentFile {
  type: 'file';
  name?: string;
  path?: string;
  content?: string;
  encoding?: string;
}

interface GitHubContentDirectoryEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
}

export interface MergeHoldOctokitLike {
  repos: {
    getContent(input: { owner: string; repo: string; path: string; ref: string }): Promise<{
      data: GitHubContentFile | GitHubContentDirectoryEntry[];
    }>;
  };
}

let octokit: Promise<MergeHoldOctokitLike> | null = null;

async function getOctokit(): Promise<MergeHoldOctokitLike> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  octokit ??= import('@octokit/rest').then(
    module => new module.Octokit({ auth: token }) as unknown as MergeHoldOctokitLike
  );
  return octokit;
}

function decodeFailure(): Error & { status: number } {
  const error = new Error('wo_spec_decode_failed') as Error & { status: number };
  error.status = 422;
  return error;
}

/** Canonical padded base64. Empty is an empty document, not a decode failure. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeFile(data: GitHubContentFile | GitHubContentDirectoryEntry[]): string {
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
    throw decodeFailure();
  }
  if (data.encoding !== 'base64') throw decodeFailure();
  // GitHub wraps base64 at 60 columns. Only those line breaks are removed.
  // Node's Buffer decoder ignores illegal characters and replacement-decodes
  // invalid UTF-8, which would turn a corrupt spec into a non-hold and merge.
  const compact = data.content.replace(/[ \t\r\n]/g, '');
  if (!CANONICAL_BASE64.test(compact)) throw decodeFailure();
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) throw decodeFailure();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw decodeFailure();
  }
}

/**
 * Whole-line header only. Case-insensitive key and value; no comments or prose.
 * Spaces and tabs may surround `true`. A newline between the key and the value
 * is not a header (`merge_hold:` and `true` on separate lines do not hold).
 */
export function specDeclaresMergeHold(text: string): boolean {
  return /^merge_hold:[ \t]*true[ \t]*\r?$/im.test(text);
}

/**
 * Read docs/work-orders/<woId>.md from bdc-xo main.
 * Rethrows Octokit errors, including 404. Decode failures throw status 422.
 * Spec text is never logged.
 */
export async function readWoSpecForMergeHold(
  woId: string,
  client?: MergeHoldOctokitLike
): Promise<string> {
  const github = client ?? (await getOctokit());
  const woResponse = await github.repos.getContent({
    owner: BDC_OWNER,
    repo: BDC_XO_REPO,
    path: `docs/work-orders/${woId}.md`,
    ref: BDC_XO_REF,
  });
  return decodeFile(woResponse.data);
}
