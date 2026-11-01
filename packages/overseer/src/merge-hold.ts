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

function decodeFile(data: GitHubContentFile | GitHubContentDirectoryEntry[]): string {
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
    throw decodeFailure();
  }
  if (data.encoding !== 'base64') throw decodeFailure();
  return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

/** Whole-line header only. Case-insensitive key and value; no comments or prose. */
export function specDeclaresMergeHold(text: string): boolean {
  return /^merge_hold:\s*true\s*$/im.test(text);
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
