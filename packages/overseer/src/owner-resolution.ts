const BDC_OWNER = 'bluedevilcollectibles';
const BDC_XO_REPO = 'bdc-xo';
const BDC_XO_REF = 'main';
const MOTIONS_PATH = 'docs/board/motions';

export type BoardSeat = 'Claude' | 'GPT' | 'Grok';

interface GitHubContentFile {
  type: 'file';
  name: string;
  path: string;
  content?: string;
  encoding?: string;
}

interface GitHubContentDirectoryEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
}

export interface OwnerResolutionOctokitLike {
  repos: {
    getContent(input: { owner: string; repo: string; path: string; ref: string }): Promise<{
      data: GitHubContentFile | GitHubContentDirectoryEntry[];
    }>;
  };
}

let octokit: Promise<OwnerResolutionOctokitLike> | null = null;

async function getOctokit(): Promise<OwnerResolutionOctokitLike> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  octokit ??= import('@octokit/rest').then(
    module => new module.Octokit({ auth: token }) as unknown as OwnerResolutionOctokitLike
  );
  return octokit;
}

function decodeFile(data: GitHubContentFile | GitHubContentDirectoryEntry[]): string | null {
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return null;
  if (data.encoding !== 'base64') return null;
  return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

function seatFromText(value: string): BoardSeat | null {
  const seats = new Set<BoardSeat>();
  if (/\b(?:claude|opus|fable|acting xo)\b/i.test(value)) seats.add('Claude');
  if (/\b(?:gpt|codex|sol)\b/i.test(value)) seats.add('GPT');
  if (/\bgrok\b/i.test(value)) seats.add('Grok');
  return seats.size === 1 ? ([...seats][0] ?? null) : null;
}

export function extractBoardSeat(motion: string): BoardSeat | null {
  const proposer = /^\s*\*{0,2}(?:Proposed by|Mover):\*{0,2}\s*(.+?)\s*$/im.exec(motion)?.[1];
  const proposedSeat = proposer ? seatFromText(proposer) : null;
  if (proposedSeat) return proposedSeat;

  const approvingSeats = new Set<BoardSeat>();
  const approvalHeading = /^#{2,4}\s+(.+?)\s+--\s+APPROVE(?:\s|$)/gim;
  for (const match of motion.matchAll(approvalHeading)) {
    const seat = seatFromText(match[1] ?? '');
    if (seat) approvingSeats.add(seat);
  }
  return approvingSeats.size === 1 ? ([...approvingSeats][0] ?? null) : null;
}

function motionFilenameMatches(name: string, motionId: string): boolean {
  const suffix = motionId.replace(/^M-/i, '');
  if (!suffix) return false;
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^M-\\d{8}-${escaped}(?:-|\\.md$)`, 'i').test(name);
}

export async function resolveWoBoardSeatOwner(
  woId: string,
  client?: OwnerResolutionOctokitLike
): Promise<BoardSeat | null> {
  try {
    const github = client ?? (await getOctokit());
    const woResponse = await github.repos.getContent({
      owner: BDC_OWNER,
      repo: BDC_XO_REPO,
      path: `docs/work-orders/${woId}.md`,
      ref: BDC_XO_REF,
    });
    const woSpec = decodeFile(woResponse.data);
    if (!woSpec) return null;

    const motionId = /^\s*Parent motion:\s*(M-\S+)/im.exec(woSpec)?.[1];
    if (!motionId) return null;

    const directoryResponse = await github.repos.getContent({
      owner: BDC_OWNER,
      repo: BDC_XO_REPO,
      path: MOTIONS_PATH,
      ref: BDC_XO_REF,
    });
    if (!Array.isArray(directoryResponse.data)) return null;
    const matches = directoryResponse.data.filter(
      entry => entry.type === 'file' && motionFilenameMatches(entry.name, motionId)
    );
    if (matches.length !== 1 || !matches[0]) return null;

    const motionResponse = await github.repos.getContent({
      owner: BDC_OWNER,
      repo: BDC_XO_REPO,
      path: matches[0].path,
      ref: BDC_XO_REF,
    });
    const motion = decodeFile(motionResponse.data);
    return motion ? extractBoardSeat(motion) : null;
  } catch {
    return null;
  }
}
