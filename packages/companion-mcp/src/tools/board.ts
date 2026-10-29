import { readFile } from 'node:fs/promises';

import {
  PROPOSAL_KINDS,
  REGISTER_PATH,
  RULING_STATUS_WORDS,
  secretaryLabel,
  utcCompact,
} from '../constants';
import { DispatchClient } from '../dispatch-client';
import { ToolFailure } from '../errors';
import { scrub } from '../scrub';
import type { CompanionSlot, ProposalFile } from '../types';

export interface GithubConfig {
  apiBase: string;
  repo: string;
  base: string;
  tokenFile: string;
}

interface GithubResponse {
  status: number;
  json: unknown;
}

interface PreparedFile {
  path: string;
  content: string;
  kind: 'register' | 'motion' | 'round';
}

export const BOARD_RECORD_PROPOSE_TOOL = 'board_record_propose';

const BOARD_REPOSITORY = 'thinmansoftware/bdc-xo';

const MOTION_SUFFIX =
  /^docs\/board\/motions\/M-[A-Za-z0-9][A-Za-z0-9.-]*\.(brief|questions|discussion|synthesis|checklist)\.md$/;
const NEW_MOTION = /^docs\/board\/motions\/M-[A-Za-z0-9][A-Za-z0-9-]*-[a-z0-9][a-z0-9-]*\.md$/;
const DESIGN_ROUND = /^docs\/board\/design-rounds\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rulingViolation(content: string): string | null {
  const folded = content.toLowerCase();
  for (const word of RULING_STATUS_WORDS) {
    if (new RegExp(`\\b${word.toLowerCase()}\\b`).test(folded)) {
      return word;
    }
  }
  if (/^#{1,6}\s+ruling\b/m.test(folded) || /^ruling\s*$/m.test(folded)) {
    return 'ruling_section';
  }
  const lines = content.split('\n');
  const attributesJohn = lines.some(line => {
    if (!/\bJohn\b/.test(line) || line.includes('John, verbatim:')) {
      return false;
    }
    return (
      /\b(decided|decision|ruled|ruling|approved|directed|said|ordered|chose)\b/i.test(line) ||
      /^John\s*:/.test(line.trim()) ||
      /John's\b/.test(line)
    );
  });
  if (!attributesJohn) {
    return null;
  }
  const hasSource = lines.some(line => line.includes('John, verbatim:'));
  return hasSource ? null : 'unsourced_john';
}

function classifyPath(filePath: string): PreparedFile['kind'] | null {
  const folded = filePath.toLowerCase();
  if (folded.includes('ruling') || filePath.endsWith('.votes.md') || filePath.includes('/votes/')) {
    return null;
  }
  if (filePath === REGISTER_PATH) {
    return 'register';
  }
  if (MOTION_SUFFIX.test(filePath) || DESIGN_ROUND.test(filePath)) {
    return 'round';
  }
  if (NEW_MOTION.test(filePath)) {
    return 'motion';
  }
  return null;
}

function lexicalBoardPath(filePath: string): string | null {
  if (filePath.length === 0 || filePath.length > 512) {
    return null;
  }
  if (filePath.startsWith('/') || filePath.startsWith('\\') || /^[A-Za-z]:/.test(filePath)) {
    return null;
  }
  if (filePath.includes('\\') || filePath.includes('\0')) {
    return null;
  }
  const parts = filePath.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    return null;
  }
  if (!filePath.startsWith('docs/board/')) {
    return null;
  }
  return filePath;
}

const PROPOSAL_KIND_SET: ReadonlySet<string> = new Set(PROPOSAL_KINDS);

function readGithubConfig(env: Record<string, string | undefined>): GithubConfig | null {
  const repo = env.COMPANION_BOARD_REPO;
  const base = env.COMPANION_BOARD_BASE;
  const tokenFile = env.COMPANION_GITHUB_TOKEN_FILE;
  if (
    repo === undefined ||
    repo.trim() === '' ||
    base === undefined ||
    base.trim() === '' ||
    tokenFile === undefined ||
    tokenFile.trim() === ''
  ) {
    return null;
  }
  const apiBase = env.COMPANION_GITHUB_API_BASE;
  return {
    apiBase: apiBase !== undefined && apiBase.trim() !== '' ? apiBase : 'https://api.github.com',
    repo: repo.trim(),
    base: base.trim(),
    tokenFile: tokenFile.trim(),
  };
}

function localProposal(
  slot: CompanionSlot,
  kind: string,
  motionId: string,
  files: ProposalFile[]
): PreparedFile[] {
  if (!PROPOSAL_KIND_SET.has(kind)) {
    throw new ToolFailure('refused', 'path_refused');
  }
  if (!/^M-[A-Za-z0-9][A-Za-z0-9-]*$/.test(motionId)) {
    throw new ToolFailure('refused', 'path_refused');
  }
  if (files.length === 0) {
    throw new ToolFailure('refused', 'path_refused');
  }
  const seen = new Set<string>();
  const prepared: PreparedFile[] = [];
  for (const file of files) {
    const path = lexicalBoardPath(file.path);
    if (path === null || seen.has(path)) {
      throw new ToolFailure('refused', 'path_refused');
    }
    seen.add(path);
    const fileKind = classifyPath(path);
    if (fileKind === null) {
      throw new ToolFailure('refused', 'path_refused');
    }
    if (fileKind !== 'register') {
      const violation = rulingViolation(file.content);
      if (violation !== null) {
        throw new ToolFailure('refused', 'ruling_refused');
      }
    }
    prepared.push({ path, content: file.content, kind: fileKind });
  }
  if (slot.companion_id.length === 0) {
    throw new ToolFailure('refused', 'path_refused');
  }
  return prepared;
}

function addedRegisterLines(base: string, proposed: string): string | null {
  if (base.length === 0 || !proposed.startsWith(base) || proposed.length <= base.length) {
    return null;
  }
  let added = proposed.slice(base.length);
  if (!base.endsWith('\n') && added.startsWith('\n')) {
    added = added.slice(1);
  }
  if (added.endsWith('\n')) {
    added = added.slice(0, -1);
  }
  if (added.length === 0 || added.includes('\n') || added.includes('\r')) {
    return null;
  }
  if (!added.startsWith('|') || !added.endsWith('|') || added.split('|').length < 3) {
    return null;
  }
  return added;
}

function assertRegisterAddition(base: string, proposed: string, companionId: string): void {
  const label = secretaryLabel(companionId);
  if (proposed.startsWith(label) && !base.startsWith(label)) {
    throw new ToolFailure('refused', 'path_refused');
  }
  const added = addedRegisterLines(base, proposed);
  if (added === null) {
    throw new ToolFailure('refused', 'path_refused');
  }
  if (rulingViolation(added) !== null) {
    throw new ToolFailure('refused', 'ruling_refused');
  }
  if (!added.includes(label)) {
    throw new ToolFailure('refused', 'path_refused');
  }
}

async function readToken(tokenFile: string): Promise<string> {
  try {
    const value = (await readFile(tokenFile, 'utf8')).trim();
    if (value.length === 0) {
      throw new Error('empty');
    }
    return value;
  } catch {
    throw new ToolFailure('error', 'github_credential_unavailable');
  }
}

function repoPrefix(config: GithubConfig): string {
  return `/repos/${config.repo}/`;
}

async function githubRequest(
  config: GithubConfig,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<GithubResponse> {
  if (!path.startsWith(repoPrefix(config))) {
    throw new ToolFailure('error', 'github_scope_refused');
  }
  if (method !== 'GET') {
    const baseRef = `${repoPrefix(config)}git/refs/heads/${config.base}`;
    if (path === baseRef || path.startsWith(`${baseRef}/`)) {
      throw new ToolFailure('error', 'github_scope_refused');
    }
    if (/\/(merge|reviews|protection|branch-protection)(?:\/|$)/.test(path)) {
      throw new ToolFailure('error', 'github_scope_refused');
    }
  }
  const url = `${config.apiBase.replace(/\/$/, '')}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'bdc-companion-mcp',
        'x-github-api-version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ToolFailure('error', 'github_unavailable');
  }
  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { status: response.status, json };
}

function readSha(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (typeof payload.sha === 'string') {
    return payload.sha;
  }
  const object = payload.object;
  if (isRecord(object) && typeof object.sha === 'string') {
    return object.sha;
  }
  return null;
}

function readTreeSha(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const tree = payload.tree;
  if (isRecord(tree) && typeof tree.sha === 'string') {
    return tree.sha;
  }
  return null;
}

function decodeContent(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.content !== 'string') {
    return null;
  }
  const encoding = payload.encoding;
  if (encoding === 'base64' || encoding === undefined) {
    return Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
  }
  if (encoding === 'utf-8') {
    return payload.content;
  }
  return null;
}

async function readBaseFile(
  config: GithubConfig,
  token: string,
  baseSha: string,
  filePath: string
): Promise<string | null> {
  const encoded = filePath
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
  const response = await githubRequest(
    config,
    token,
    'GET',
    `${repoPrefix(config)}contents/${encoded}?ref=${encodeURIComponent(baseSha)}`
  );
  if (response.status === 404) {
    return null;
  }
  if (response.status !== 200) {
    throw new ToolFailure('error', 'github_read_failed');
  }
  const decoded = decodeContent(response.json);
  if (decoded === null) {
    throw new ToolFailure('error', 'github_read_failed');
  }
  return decoded;
}

export async function boardRecordPropose(
  dispatch: DispatchClient,
  slot: CompanionSlot,
  env: Record<string, string | undefined>,
  kind: string,
  motionId: string,
  files: ProposalFile[],
  summary: string
): Promise<{ pr_url: string; branch: string; motion_id: string; kind: string }> {
  const prepared = localProposal(slot, kind, motionId, files);
  if (summary.trim() === '') {
    throw new ToolFailure('refused', 'path_refused');
  }
  const config = readGithubConfig(env);
  if (config?.repo !== BOARD_REPOSITORY) {
    throw new ToolFailure('error', 'github_credential_unavailable');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(config.base) || config.base.includes('..')) {
    throw new ToolFailure('error', 'github_credential_unavailable');
  }
  const token = await readToken(config.tokenFile);
  const ref = await githubRequest(
    config,
    token,
    'GET',
    `${repoPrefix(config)}git/ref/heads/${config.base
      .split('/')
      .map(part => encodeURIComponent(part))
      .join('/')}`
  );
  if (ref.status !== 200) {
    throw new ToolFailure('error', 'github_read_failed');
  }
  const baseSha = readSha(ref.json);
  if (baseSha === null) {
    throw new ToolFailure('error', 'github_read_failed');
  }
  const label = secretaryLabel(slot.companion_id);
  for (const file of prepared) {
    const existing = await readBaseFile(config, token, baseSha, file.path);
    if (
      file.path.startsWith('docs/board/motions/') &&
      file.path !== REGISTER_PATH &&
      existing !== null
    ) {
      throw new ToolFailure('refused', 'path_refused');
    }
    if (file.kind === 'motion') {
      if (!file.content.startsWith(label)) {
        throw new ToolFailure('refused', 'path_refused');
      }
    } else if (file.kind === 'round') {
      if (existing === null && !file.content.startsWith(label)) {
        throw new ToolFailure('refused', 'path_refused');
      }
    } else {
      const base = existing ?? '';
      assertRegisterAddition(base, file.content, slot.companion_id);
    }
  }
  const commitInfo = await githubRequest(
    config,
    token,
    'GET',
    `${repoPrefix(config)}git/commits/${baseSha}`
  );
  if (commitInfo.status !== 200) {
    throw new ToolFailure('error', 'github_read_failed');
  }
  const baseTree = readTreeSha(commitInfo.json);
  if (baseTree === null) {
    throw new ToolFailure('error', 'github_read_failed');
  }
  const treeEntries: { path: string; mode: '100644'; type: 'blob'; sha: string }[] = [];
  for (const file of prepared) {
    const blob = await githubRequest(config, token, 'POST', `${repoPrefix(config)}git/blobs`, {
      content: file.content,
      encoding: 'utf-8',
    });
    if (blob.status !== 201 && blob.status !== 200) {
      throw new ToolFailure('error', 'github_write_failed');
    }
    const blobSha = readSha(blob.json);
    if (blobSha === null) {
      throw new ToolFailure('error', 'github_write_failed');
    }
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blobSha });
  }
  const tree = await githubRequest(config, token, 'POST', `${repoPrefix(config)}git/trees`, {
    base_tree: baseTree,
    tree: treeEntries,
  });
  if (tree.status !== 201 && tree.status !== 200) {
    throw new ToolFailure('error', 'github_write_failed');
  }
  const treeSha = readSha(tree.json);
  if (treeSha === null) {
    throw new ToolFailure('error', 'github_write_failed');
  }
  const branch = `companion/${slot.companion_id}/${motionId}-${utcCompact()}`;
  const commit = await githubRequest(config, token, 'POST', `${repoPrefix(config)}git/commits`, {
    message: `${kind} ${motionId}\n\n${summary}\n\n${label}`,
    tree: treeSha,
    parents: [baseSha],
  });
  if (commit.status !== 201 && commit.status !== 200) {
    throw new ToolFailure('error', 'github_write_failed');
  }
  const commitSha = readSha(commit.json);
  if (commitSha === null) {
    throw new ToolFailure('error', 'github_write_failed');
  }
  const created = await githubRequest(config, token, 'POST', `${repoPrefix(config)}git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: commitSha,
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new ToolFailure('error', 'github_write_failed');
  }
  const pull = await githubRequest(config, token, 'POST', `${repoPrefix(config)}pulls`, {
    title: `Board record ${kind} ${motionId}`,
    head: branch,
    base: config.base,
    body: `${label}\n\nMotion: ${motionId}\nKind: ${kind}\n\n${summary}`,
  });
  if (pull.status === 409) {
    throw new ToolFailure('error', 'pr_create_conflict');
  }
  if (pull.status !== 201 && pull.status !== 200) {
    throw new ToolFailure('error', 'github_write_failed');
  }
  const prUrl =
    isRecord(pull.json) && typeof pull.json.html_url === 'string' ? pull.json.html_url : '';
  if (prUrl.length === 0) {
    throw new ToolFailure('error', 'github_write_failed');
  }
  const safeUrl = scrub(prUrl);
  await dispatch.send(slot, {
    recipient: 'xo',
    text: `Board record pull request: ${safeUrl}`,
    correlationId: `board-record-${motionId}-${utcCompact()}`,
  });
  return { pr_url: safeUrl, branch, motion_id: motionId, kind };
}
