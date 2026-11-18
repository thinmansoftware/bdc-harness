import { createHash } from 'node:crypto';

export const BUNDLE_PATH = 'packages/workflows/src/defaults/bundled-defaults.generated.ts';
export const PRODUCER_ANCHOR = '21bf3f8ec537e12928d3a831eb2ebbfa5d9677bc';
export const ARCHIVE_DIGEST = '8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed';
const WORKFLOW = '.github/workflows/test.yml';
const HELPER = 'scripts/ci/verified-bundle-proof.py';
const INPUTS = [
  '.archon/commands/defaults/',
  '.archon/workflows/defaults/',
  'harness/policies/',
  'scripts/lane/',
];
const SHA = /^[a-f0-9]{40}$/;
export function configuredBundleProducer(
  env: Record<string, string | undefined> = process.env
): string | null {
  const pin = env.OVERSEER_BUNDLE_PRODUCER_COMMIT;
  return env.OVERSEER_BUNDLE_EXCLUSION_ENABLED === '1' && pin && SHA.test(pin) ? pin : null;
}
export type ProofRead = (route: string, params: Record<string, unknown>) => Promise<unknown>;
export interface Entry {
  sha: string;
  mode: string;
}
export type Inventory = Map<string, Entry>;
export interface BundleCoverage {
  notice: string;
  baseSha: string;
  producer: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_evidence');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_evidence');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('invalid_evidence');
  return value;
}
function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid_evidence');
}
function same(a: Entry | undefined, b: Entry | undefined): boolean {
  return a?.sha === b?.sha && a?.mode === b?.mode;
}
function regular(entry: Entry | undefined): boolean {
  return !!entry && ['100644', '100755'].includes(entry.mode);
}
export function inputInventoriesMatch(tested: Inventory, head: Inventory): boolean {
  return [...new Set([...tested.keys(), ...head.keys()])]
    .filter(path => path === BUNDLE_PATH || INPUTS.some(prefix => path.startsWith(prefix)))
    .every(path => regular(tested.get(path)) && same(tested.get(path), head.get(path)));
}
function closure(path: string): boolean {
  const name = path.split('/').at(-1) ?? '';
  return (
    path === WORKFLOW ||
    path === HELPER ||
    path === 'scripts/generate-bundled-defaults.ts' ||
    path.startsWith('.husky/') ||
    path.startsWith('patches/') ||
    /\.(json|jsonc|lock)$/.test(name) ||
    /^(\.env|\.npm|\.yarn|bunfig|\.bunfig|\.bun-version|\.tool-versions|\.gitattributes|\.gitmodules)/.test(
      name
    )
  );
}
export function producerClosureMatches(
  anchor: Inventory,
  producer: Inventory,
  tested: Inventory,
  head: Inventory
): boolean {
  const paths = new Set([...anchor.keys(), ...producer.keys(), ...tested.keys(), ...head.keys()]);
  return [...paths].filter(closure).every(path => {
    if (path === WORKFLOW || path === HELPER) {
      // Only the independently admitted producer delta may replace the frozen head producer.
      return (
        regular(producer.get(path)) &&
        same(tested.get(path), producer.get(path)) &&
        (same(head.get(path), anchor.get(path)) || same(head.get(path), producer.get(path)))
      );
    }
    return (
      same(anchor.get(path), producer.get(path)) &&
      same(anchor.get(path), tested.get(path)) &&
      same(anchor.get(path), head.get(path)) &&
      (!anchor.has(path) || regular(anchor.get(path)))
    );
  });
}

async function tree(
  read: ProofRead,
  commit: string
): Promise<{ entries: Inventory; treeSha: string; parents: string[] }> {
  requireProof(SHA.test(commit));
  const c = object(
    await read('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { commit_sha: commit })
  );
  const treeSha = string(object(c.tree).sha);
  const entries: Inventory = new Map();
  let count = 0;
  async function walk(sha: string, prefix: string): Promise<void> {
    requireProof(++count <= 10_000 && SHA.test(sha));
    let result = object(
      await read('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        tree_sha: sha,
        recursive: '1',
      })
    );
    if (result.truncated === true) {
      result = object(
        await read('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { tree_sha: sha })
      );
      requireProof(result.truncated === false);
      for (const raw of list(result.tree)) {
        const e = object(raw);
        const path = prefix + string(e.path);
        if (e.type === 'tree') await walk(string(e.sha), path + '/');
        else add(path, e);
      }
    } else {
      requireProof(result.truncated === false);
      for (const raw of list(result.tree)) {
        const e = object(raw);
        if (e.type !== 'tree') add(prefix + string(e.path), e);
      }
    }
  }
  function add(path: string, e: Record<string, unknown>): void {
    requireProof(
      entries.size < 100_000 &&
        !entries.has(path) &&
        e.type === 'blob' &&
        SHA.test(string(e.sha)) &&
        /^[!-~]+$/.test(path) &&
        !/["\\]/.test(path) &&
        !path.split('/').some(p => !p || p === '..' || p === '.')
    );
    const entry = { mode: string(e.mode), sha: string(e.sha) };
    requireProof(regular(entry));
    entries.set(path, entry);
  }
  await walk(treeSha, '');
  return { entries, treeSha, parents: list(c.parents).map(p => string(object(p).sha)) };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
async function blob(read: ProofRead, sha: string): Promise<Buffer> {
  const result = object(
    await read('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { file_sha: sha })
  );
  requireProof(result.encoding === 'base64' && result.sha === sha);
  const bytes = Buffer.from(string(result.content).replace(/\s/g, ''), 'base64');
  requireProof(bytes.length <= 32_000_000);
  requireProof(
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === sha
  );
  return bytes;
}

/** Apply every text hunk to authenticated base bytes, then require exact head bytes. */
export function reconcilesText(block: string, before: Buffer, after: Buffer): boolean {
  try {
    const decode = (b: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(b);
    const old = decode(before).match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const expected = decode(after);
    const lines = block.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let cursor = 0;
    const output: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].startsWith('@@ ')) continue;
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!h) return false;
      const oldCount = Number(h[2] ?? 1),
        newCount = Number(h[4] ?? 1);
      const start = Number(h[1]) - (oldCount === 0 ? 0 : 1);
      if (start < cursor || start > old.length) return false;
      output.push(...old.slice(cursor, start));
      cursor = start;
      if (output.length !== Number(h[3]) - (newCount === 0 ? 0 : 1)) return false;
      let consumed = 0,
        added = 0;
      while (i + 1 < lines.length && !lines[i + 1].startsWith('@@ ')) {
        const line = lines[++i];
        const kind = line[0];
        if (![' ', '+', '-'].includes(kind)) return false;
        let text = line.slice(1);
        if (lines[i + 1]?.startsWith('\\ No newline at end of file')) {
          text = text.replace(/\n$/, '');
          i++;
        }
        if (kind !== '+') {
          if (old[cursor++] !== text) return false;
          consumed++;
        }
        if (kind !== '-') {
          output.push(text);
          added++;
        }
      }
      if (consumed !== oldCount || added !== newCount) return false;
    }
    output.push(...old.slice(cursor));
    return output.join('') === expected;
  } catch {
    return false;
  }
}

export async function reconcileDiff(
  read: ProofRead,
  diff: string,
  before: Inventory,
  after: Inventory
): Promise<string[]> {
  requireProof(diff.startsWith('diff --git '));
  requireProof(Buffer.byteLength(diff, 'utf8') <= 32_000_000);
  const changed = new Set(
    [...new Set([...before.keys(), ...after.keys()])].filter(
      p => !same(before.get(p), after.get(p))
    )
  );
  const covered = new Set<string>();
  const blocks = diff.split(/(?=^diff --git )/m);
  const cache = new Map<string, Buffer>();
  let totalBytes = 0;
  const bytes = async (e: Entry | undefined): Promise<Buffer> => {
    if (!e) return Buffer.alloc(0);
    if (!cache.has(e.sha)) {
      const raw = await blob(read, e.sha);
      totalBytes += raw.length;
      requireProof(totalBytes <= 64_000_000);
      cache.set(e.sha, raw);
    }
    const value = cache.get(e.sha);
    requireProof(value);
    return value;
  };
  for (const block of blocks) {
    // Explicit header grammar: unsupported quoted paths fail closed.
    const match = /^diff --git a\/([^\s"]+) b\/([^\s"]+)\n/.exec(block);
    requireProof(match);
    const [, a, b] = match;
    const paths = [...new Set([a, b])].filter(p => changed.has(p));
    requireProof(paths.length > 0 && paths.every(p => !covered.has(p)));
    const old = before.get(a),
      next = after.get(b);
    requireProof(old || next);
    const [oldBytes, nextBytes] = await Promise.all([bytes(old), bytes(next)]);
    if (/^(Binary files .+ differ|GIT binary patch)$/m.test(block)) {
      requireProof(
        oldBytes.subarray(0, 8000).includes(0) || nextBytes.subarray(0, 8000).includes(0)
      );
    } else {
      requireProof(reconcilesText(block, oldBytes, nextBytes));
    }
    if (old && next && old.mode !== next.mode) {
      requireProof(block.includes(`old mode ${old.mode}\nnew mode ${next.mode}`));
    }
    paths.forEach(p => covered.add(p));
  }
  requireProof(covered.size === changed.size);
  return blocks;
}

export interface BundleRequest {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
}
export async function collectBundleCoverage(
  read: ProofRead,
  input: BundleRequest,
  producer: string
): Promise<{ diff: string; coverage?: BundleCoverage; bundleProofUnavailable?: boolean }> {
  const { headSha, baseSha, prNumber } = input;
  const comparison = object(
    await read('GET /repos/{owner}/{repo}/compare/{basehead}', {
      basehead: `${baseSha}...${headSha}`,
    })
  );
  const mergeBase = string(object(comparison.merge_base_commit).sha);
  // Coverage authentication is mandatory even when producer proof is unavailable.
  const [before, head] = await Promise.all([tree(read, mergeBase), tree(read, headSha)]);
  const whole = await read('GET /repos/{owner}/{repo}/compare/{basehead}', {
    basehead: `${baseSha}...${headSha}`,
    headers: { accept: 'application/vnd.github.diff' },
  });
  const diff = string(whole);
  const blocks = await reconcileDiff(read, diff, before.entries, head.entries);
  const marked = (text: string): string =>
    text.replace(
      /^(Binary files .+ differ|GIT binary patch)$/gm,
      '$&\n[binary or patch unavailable]'
    );
  try {
    requireProof(
      input.owner === 'thinmansoftware' && input.repo === 'bdc-harness' && SHA.test(producer)
    );
    requireProof(object(await read('GET /repos/{owner}/{repo}', {})).id === 1233963411);
    const workflow = object(
      await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}', {
        workflow_id: 273810118,
      })
    );
    requireProof(workflow.path === WORKFLOW && workflow.id === 273810118);
    const runs = object(
      await read('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
        workflow_id: 273810118,
        event: 'pull_request',
        head_sha: headSha,
        per_page: 100,
      })
    );
    const candidates = list(runs.workflow_runs).map(object);
    requireProof(candidates.length > 0 && Number(runs.total_count) === candidates.length);
    candidates.sort((a, b) => Number(b.id) - Number(a.id));
    const run = object(
      await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: candidates[0].id })
    );
    requireProof(
      run.event === 'pull_request' &&
        run.path === WORKFLOW &&
        run.head_sha === headSha &&
        run.workflow_id === workflow.id &&
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        object(run.repository).id === 1233963411
    );
    requireProof(
      list(run.pull_requests).some(
        p =>
          object(p).number === prNumber &&
          object(object(p).head).sha === headSha &&
          object(object(p).base).sha === baseSha
      )
    );
    const jobs = object(
      await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
        run_id: run.id,
        attempt_number: run.run_attempt,
        per_page: 100,
      })
    );
    requireProof(Number(jobs.total_count) === list(jobs.jobs).length);
    const selected = list(jobs.jobs)
      .map(object)
      .filter(j => j.name === 'test (ubuntu-latest)');
    requireProof(selected.length === 1);
    const job = selected[0];
    requireProof(
      job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.status === 'completed' &&
        job.conclusion === 'success'
    );
    const steps = list(job.steps).map(object);
    requireProof(
      steps.some(
        s =>
          s.number === 3 &&
          s.name === 'Verified bundle producer' &&
          s.status === 'completed' &&
          s.conclusion === 'success'
      )
    );
    const check = object(
      await read('GET /repos/{owner}/{repo}/check-runs/{check_run_id}', { check_run_id: job.id })
    );
    requireProof(
      check.id === job.id &&
        check.status === 'completed' &&
        check.conclusion === 'success' &&
        check.head_sha === headSha &&
        object(check.app).id === 15368 &&
        object(check.check_suite).id === run.check_suite_id
    );
    const suite = object(
      await read('GET /repos/{owner}/{repo}/check-suites/{check_suite_id}', {
        check_suite_id: run.check_suite_id,
      })
    );
    requireProof(
      suite.id === run.check_suite_id &&
        suite.head_sha === headSha &&
        object(suite.app).id === 15368
    );
    const logs = string(
      await read('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { job_id: job.id })
    );
    const matches = [
      ...logs.matchAll(/^\d{4}-\d\d-\d\dT[\d:.]+Z BUNDLE_PROOF_V1 ([A-Za-z0-9+/=]+)\r?$/gm),
    ];
    requireProof(matches.length === 1);
    const encoded = matches[0][1];
    const raw = Buffer.from(encoded, 'base64');
    requireProof(raw.toString('base64') === encoded && raw.length <= 10_000);
    const proof = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    requireProof(
      proof.schema === 1 &&
        proof.repository === `${input.owner}/${input.repo}` &&
        proof.pr === prNumber &&
        proof.run === run.id &&
        proof.attempt === run.run_attempt &&
        proof.head === headSha &&
        proof.base === baseSha &&
        proof.archive === ARCHIVE_DIGEST &&
        proof.platform === 'linux-x64' &&
        /^[a-f0-9]{64}$/.test(string(proof.runtime)) &&
        !!proof.image &&
        !!proof.imageVersion &&
        proof.workflow === proof.checkout &&
        proof.workflowRef ===
          `${input.owner}/${input.repo}/${WORKFLOW}@refs/pull/${prNumber}/merge` &&
        !!proof.python &&
        !!proof.git &&
        /^[a-f0-9]{64}$/.test(string(proof.pythonSha256)) &&
        /^[a-f0-9]{64}$/.test(string(proof.gitSha256)) &&
        /^[a-f0-9]{64}$/.test(string(proof.nodeSha256))
    );
    const [tested, admitted, anchor] = await Promise.all([
      tree(read, string(proof.checkout)),
      tree(read, producer),
      tree(read, PRODUCER_ANCHOR),
    ]);
    requireProof(
      tested.treeSha === proof.tree && tested.parents.join(',') === [baseSha, headSha].join(',')
    );
    requireProof(
      producerClosureMatches(anchor.entries, admitted.entries, tested.entries, head.entries) &&
        inputInventoriesMatch(tested.entries, head.entries)
    );
    const bundleEntry = head.entries.get(BUNDLE_PATH);
    requireProof(bundleEntry);
    const bundle = await blob(read, bundleEntry.sha);
    requireProof(!bundle.includes(13) && sha256(bundle) === proof.bundle);
    const bundleBlocks = blocks.filter(b =>
      b.startsWith(`diff --git a/${BUNDLE_PATH} b/${BUNDLE_PATH}\n`)
    );
    requireProof(
      bundleBlocks.length === 1 && before.entries.has(BUNDLE_PATH) && head.entries.has(BUNDLE_PATH)
    );
    const retained = marked(blocks.filter(b => b !== bundleBlocks[0]).join(''));
    const live = object(
      await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: prNumber })
    );
    requireProof(object(live.head).sha === headSha && object(live.base).sha === baseSha);
    const url = `https://github.com/${input.owner}/${input.repo}/actions/runs/${String(run.id)}/job/${String(job.id)}`;
    const notice =
      `Review coverage: excluded only ${BUNDLE_PATH}; verified deterministic output, raw LF-only. ` +
      `Anchor ${PRODUCER_ANCHOR}; producer ${producer}; head ${headSha}; base ${baseSha}; tested ${String(proof.checkout)} tree ${tested.treeSha}; ` +
      `bundle ${bundleEntry.sha} sha256 ${proof.bundle}; runtime sha256 ${proof.runtime}; archive ${ARCHIVE_DIGEST}; ` +
      `run ${String(run.id)} attempt ${String(run.run_attempt)} suite ${String(suite.id)} check/job ${String(job.id)} step 3. ` +
      `Original ${Buffer.byteLength(marked(diff), 'utf8')} bytes; retained ${Buffer.byteLength(retained, 'utf8')} bytes. Proof: ${url}. Authored source retained completely.`;
    return { diff: retained, coverage: { notice, baseSha, producer } };
  } catch {
    // A complete diff with unavailable/failed/untrusted producer evidence excludes nothing.
    return { diff: marked(diff), bundleProofUnavailable: true };
  }
}
