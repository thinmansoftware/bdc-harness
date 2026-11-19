import { createHash } from 'node:crypto';

export const BUNDLE_PATH = 'packages/workflows/src/defaults/bundled-defaults.generated.ts';
export const ARCHIVE_DIGEST = '8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed';
const WORKFLOW = '.github/workflows/test.yml';
const HELPER = 'scripts/ci/verified-bundle-proof.py';
const GENERATOR = 'scripts/generate-bundled-defaults.ts';
const UBUNTU_JOB = 'test (ubuntu-latest)';
const STAMP = String.raw`^\d{4}-\d\d-\d\dT[\d:.]+Z`;
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
    path === GENERATOR ||
    path.startsWith('.husky/') ||
    path.startsWith('patches/') ||
    /\.(json|jsonc|lock)$/.test(name) ||
    /^(\.env|\.npm|\.yarn|bunfig|\.bunfig|\.bun-version|\.tool-versions|\.gitattributes|\.gitmodules)/.test(
      name
    )
  );
}
/**
 * PRE-RECEIPT paths can affect anything before the producer prints its receipt (#6398 section 4a):
 * the workflow, everything under scripts/ci/ (frozen even though most of it is not a closure
 * name: with `python3 -I` Python no longer imports from there, and a planted module there is
 * still refused), the generator, closure paths directly in the repo root or directly in scripts/
 * (Bun resolves the generator's tsconfig and package.json from scripts/ upward and reads
 * bunfig.toml from the working directory), and .gitattributes/.gitmodules at any depth.
 */
function preReceipt(path: string): boolean {
  const name = path.split('/').at(-1) ?? '';
  return (
    path === WORKFLOW ||
    path.startsWith('scripts/ci/') ||
    path === GENERATOR ||
    (closure(path) && /^(scripts\/)?[^/]+$/.test(path)) ||
    name === '.gitattributes' ||
    name === '.gitmodules'
  );
}
/**
 * D3 anchor: the pull request's authenticated base on dev (the caller proves base is on dev and
 * descends from the admitted producer). POST-RECEIPT closure paths (workspace manifests, nested
 * locks, .husky/, patches/, other JSON) run only after the receipt and are not compared; a line
 * they print can only add a second receipt or an unavailable line, and either refuses (D5).
 */
export function producerClosureMatches(
  mergeBase: Inventory,
  base: Inventory,
  producer: Inventory,
  tested: Inventory,
  head: Inventory
): boolean {
  const paths = new Set([
    ...mergeBase.keys(),
    ...base.keys(),
    ...producer.keys(),
    ...tested.keys(),
    ...head.keys(),
  ]);
  return [...paths].filter(preReceipt).every(path => {
    if (path === WORKFLOW || path === HELPER) {
      // Only the independently admitted producer may run; a head that predates it may keep its
      // merge base's copy.
      return (
        regular(producer.get(path)) &&
        same(tested.get(path), producer.get(path)) &&
        (same(head.get(path), mergeBase.get(path)) || same(head.get(path), producer.get(path)))
      );
    }
    // Dev drift is allowed (the tested merge takes dev's reviewed version); a pull-request
    // change is not.
    return (
      same(tested.get(path), base.get(path)) &&
      same(head.get(path), mergeBase.get(path)) &&
      (!base.has(path) || regular(base.get(path)))
    );
  });
}

function jobsOfAttempt(
  read: ProofRead,
  runId: unknown,
  attempt: number
): Promise<Record<string, unknown>[]> {
  return read('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
    run_id: runId,
    attempt_number: attempt,
    per_page: 100,
  }).then(raw => {
    const jobs = object(raw);
    requireProof(Number(jobs.total_count) === list(jobs.jobs).length);
    return list(jobs.jobs).map(object);
  });
}
function singleUbuntuJob(jobs: Record<string, unknown>[]): Record<string, unknown> {
  const selected = jobs.filter(j => j.name === UBUNTU_JOB);
  requireProof(selected.length === 1);
  return selected[0];
}
/**
 * D5 receipt rules over one job log. Premise (the trust argument rests on it): the log GitHub
 * returns for a job is complete and append-only, and secret masking never rewrites a line that
 * was already printed. Under that premise, any line printed after the producer's own line can
 * only ADD a second BUNDLE_PROOF_V1 line or an UNAVAILABLE line, and both refuse here.
 */
function receiptFromLog(logs: string): Record<string, unknown> {
  requireProof(!new RegExp(`${STAMP} BUNDLE_PROOF_UNAVAILABLE`, 'm').test(logs));
  const matches = [
    ...logs.matchAll(new RegExp(`${STAMP} BUNDLE_PROOF_V1 ([A-Za-z0-9+/=]+)\\r?$`, 'gm')),
  ];
  requireProof(matches.length === 1);
  const encoded = matches[0][1];
  const raw = Buffer.from(encoded, 'base64');
  requireProof(raw.toString('base64') === encoded && raw.length <= 10_000);
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
}
async function readReceipt(read: ProofRead, jobId: unknown): Promise<Record<string, unknown>> {
  return receiptFromLog(
    string(await read('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', { job_id: jobId }))
  );
}
function stepThreeSucceeded(job: Record<string, unknown>): boolean {
  return list(job.steps)
    .map(object)
    .some(
      s =>
        s.number === 3 &&
        s.name === 'Verified bundle producer' &&
        s.status === 'completed' &&
        s.conclusion === 'success'
    );
}
async function onDevAndAfterProducer(
  read: ProofRead,
  baseSha: string,
  producer: string
): Promise<boolean> {
  const [dev, admitted] = await Promise.all([
    read('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: `${baseSha}...dev` }),
    read('GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: `${producer}...${baseSha}` }),
  ]);
  const ok = (value: unknown): boolean =>
    ['identical', 'ahead'].includes(string(object(value).status));
  return ok(dev) && ok(admitted);
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
    if (!old) requireProof(next && block.includes(`\nnew file mode ${next.mode}\n`));
    if (!next) requireProof(old && block.includes(`\ndeleted file mode ${old.mode}\n`));
    if (a !== b) {
      requireProof(
        block.includes(`\nrename from ${a}\nrename to ${b}\n`) ||
          block.includes(`\ncopy from ${a}\ncopy to ${b}\n`)
      );
    }
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
export type BundleCoverageResult =
  | { diff: string; coverage?: BundleCoverage; bundleProofUnavailable?: boolean }
  | { bundleRunPending: true };
/** The newest Test Suite pull_request run for the head (repository, workflow and run reads). */
async function newestTestSuiteRun(
  read: ProofRead,
  input: BundleRequest,
  producer: string
): Promise<{ workflow: Record<string, unknown>; run: Record<string, unknown> }> {
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
      head_sha: input.headSha,
      per_page: 100,
    })
  );
  const candidates = list(runs.workflow_runs).map(object);
  requireProof(candidates.length > 0 && Number(runs.total_count) === candidates.length);
  candidates.sort((a, b) => Number(b.id) - Number(a.id));
  const run = object(
    await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: candidates[0].id })
  );
  return { workflow, run };
}
export async function collectBundleCoverage(
  read: ProofRead,
  input: BundleRequest,
  producer: string
): Promise<BundleCoverageResult> {
  const { headSha, baseSha, prNumber } = input;
  const comparison = object(
    await read('GET /repos/{owner}/{repo}/compare/{basehead}', {
      basehead: `${baseSha}...${headSha}`,
    })
  );
  const mergeBase = string(object(comparison.merge_base_commit).sha);
  // Coverage authentication is mandatory even when producer proof is unavailable.
  const [before, head] = await Promise.all([tree(read, mergeBase), tree(read, headSha)]);
  // D2a: decide early and cheaply. Only a pull request that changes the bundle needs the Test
  // Suite run; while that run (any of its six jobs) is unfinished, defer before the full diff,
  // reconciliation or any blob read. No run at all keeps the unavailable/full-diff outcome.
  let found: Awaited<ReturnType<typeof newestTestSuiteRun>> | undefined;
  if (!same(before.entries.get(BUNDLE_PATH), head.entries.get(BUNDLE_PATH))) {
    try {
      found = await newestTestSuiteRun(read, input, producer);
    } catch {
      found = undefined;
    }
    if (found && found.run.status !== 'completed') return { bundleRunPending: true };
  }
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
    requireProof(found);
    const { workflow, run } = found;
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
    // D2c: L is the latest attempt. JL is its single Ubuntu job. The receipt in JL's log names
    // the attempt A that printed it; a re-run carries an earlier attempt's job forward (new id,
    // same times, same log), and then the proof job is attempt A's own JA.
    const latest = run.run_attempt;
    requireProof(typeof latest === 'number' && Number.isInteger(latest) && latest >= 1);
    const jl = singleUbuntuJob(await jobsOfAttempt(read, run.id, latest));
    requireProof(
      jl.run_id === run.id &&
        jl.run_attempt === latest &&
        jl.status === 'completed' &&
        jl.conclusion === 'success'
    );
    let job = jl;
    let proof = await readReceipt(read, jl.id);
    const attempt = proof.attempt;
    requireProof(
      typeof attempt === 'number' && Number.isInteger(attempt) && attempt >= 1 && attempt <= latest
    );
    if (attempt < latest) {
      const ja = singleUbuntuJob(await jobsOfAttempt(read, run.id, attempt));
      requireProof(
        ja.run_id === run.id &&
          ja.run_attempt === attempt &&
          ja.status === 'completed' &&
          ja.conclusion === 'success' &&
          typeof ja.started_at === 'string' &&
          typeof ja.completed_at === 'string' &&
          ja.started_at === jl.started_at &&
          ja.completed_at === jl.completed_at
      );
      job = ja;
      proof = await readReceipt(read, ja.id);
    }
    requireProof(stepThreeSucceeded(job));
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
    requireProof(
      proof.schema === 1 &&
        proof.phase === 'preinstall' &&
        proof.dependenciesInstalled === false &&
        proof.generator === '9cc028a6a440036c50aabd14dc385cabfa5d32520ea882779371863499c24220' &&
        proof.repository === `${input.owner}/${input.repo}` &&
        proof.pr === prNumber &&
        proof.run === run.id &&
        proof.attempt === job.run_attempt &&
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
    // D3 base conditions: dev is at or ahead of base, and the admitted producer is an ancestor
    // of base. The live base ref is checked with the live head and base below.
    requireProof(await onDevAndAfterProducer(read, baseSha, producer));
    const [tested, admitted, baseTree] = await Promise.all([
      tree(read, string(proof.checkout)),
      tree(read, producer),
      tree(read, baseSha),
    ]);
    requireProof(
      tested.treeSha === proof.tree && tested.parents.join(',') === [baseSha, headSha].join(',')
    );
    requireProof(
      producerClosureMatches(
        before.entries,
        baseTree.entries,
        admitted.entries,
        tested.entries,
        head.entries
      ) && inputInventoriesMatch(tested.entries, head.entries)
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
    requireProof(
      object(live.head).sha === headSha &&
        object(live.base).sha === baseSha &&
        object(live.base).ref === 'dev'
    );
    const url = `https://github.com/${input.owner}/${input.repo}/actions/runs/${String(run.id)}/job/${String(job.id)}`;
    const notice =
      `Review coverage: excluded only ${BUNDLE_PATH}; verified deterministic output, raw LF-only. ` +
      `Anchor ${baseSha}; producer ${producer}; head ${headSha}; base ${baseSha}; tested ${String(proof.checkout)} tree ${tested.treeSha}; ` +
      `bundle ${bundleEntry.sha} sha256 ${proof.bundle}; runtime sha256 ${proof.runtime}; archive ${ARCHIVE_DIGEST}; ` +
      `run ${String(run.id)} attempt ${String(job.run_attempt)} of ${String(latest)} suite ${String(suite.id)} check/job ${String(job.id)} step 3. ` +
      `Original ${Buffer.byteLength(marked(diff), 'utf8')} bytes; retained ${Buffer.byteLength(retained, 'utf8')} bytes. Proof: ${url}. Authored source retained completely.`;
    return { diff: retained, coverage: { notice, baseSha, producer } };
  } catch {
    // A complete diff with unavailable/failed/untrusted producer evidence excludes nothing.
    return { diff: marked(diff), bundleProofUnavailable: true };
  }
}
