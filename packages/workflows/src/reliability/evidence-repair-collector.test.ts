import { describe, expect, test } from 'bun:test';
import { collectEvidenceRepairReceipt } from './evidence-repair-collector';
const sha = (c: string) => c.repeat(40);
const stamp = '2026-11-17T22:45:37.8575027Z ';
export const body = 'complete corrected evidence\n';
const repo = 'thinmansoftware/example';
const script = 'bash "${{ github.workspace }}/.bdc-ci/scripts/validate-pr-manifest.sh"\n';
const rendered = 'bash "/home/runner/work/example/example/.bdc-ci/scripts/validate-pr-manifest.sh"';
const source = `jobs:\n  manifest-validate:\n    steps:\n      - name: Checkout bdc-ci scripts\n        uses: actions/checkout@v4\n        with:\n          repository: thinmansoftware/bdc-ci\n          path: .bdc-ci\n      - name: Validate manifest v2 block\n        env:\n          PR_BODY: \u0024{{ github.event.pull_request.body }}\n          GREP_RUNNER: \u0024{{ github.workspace }}/.bdc-ci/scripts/run-grep-assertions.sh\n        run: |\n          ${script.trim()}\n`;
export function fixture() {
  const data = new Map<string, unknown>();
  const text = new Map<string, string>();
  const root = `repos/${repo}`;
  for (const [check, run, conclusion] of [
    [30, 10, 'failure'],
    [31, 11, 'success'],
  ] as const) {
    data.set(`${root}/check-runs/${check}`, {
      id: check,
      name: 'manifest-validate / manifest-validate',
      app: { id: 15368 },
      head_sha: sha('a'),
      status: 'completed',
      conclusion,
      check_suite: { id: run + 100 },
      details_url: `https://github.com/${repo}/actions/runs/${run}/job/${check}`,
    });
    data.set(`${root}/actions/jobs/${check}`, {
      id: check,
      run_id: run,
      run_attempt: 1,
      head_sha: sha('a'),
      name: 'manifest-validate / manifest-validate',
      status: 'completed',
      conclusion,
      check_run_url: `https://api.github.com/${root}/check-runs/${check}`,
      steps: [
        { number: 3, name: 'Checkout caller repo', conclusion: 'success', status: 'completed' },
        { number: 4, name: 'Checkout bdc-ci scripts', conclusion: 'success', status: 'completed' },
        { number: 6, name: 'Validate manifest v2 block', conclusion, status: 'completed' },
      ],
    });
    data.set(`${root}/actions/runs/${run}/attempts/1`, {
      id: run,
      run_attempt: 1,
      workflow_id: 20,
      path: '.github/workflows/ci.yml',
      head_sha: sha('a'),
      event: 'pull_request',
      repository: { id: 1, full_name: repo },
      check_suite_id: run + 100,
      pull_requests: [
        {
          number: 7,
          head: { sha: sha('a'), repo: { id: 1 } },
          base: { sha: sha('f'), repo: { id: 1 } },
        },
      ],
      referenced_workflows: [
        {
          path: 'thinmansoftware/bdc-ci/.github/workflows/manifest-validate.yml@v0.1.1',
          sha: sha('c'),
        },
      ],
    });
    text.set(
      `${root}/actions/jobs/${check}/steps/3/logs`,
      stamp + '[command]/usr/bin/git log -1 --format=%H\n' + stamp + sha('e') + '\n'
    );
    text.set(
      `${root}/actions/jobs/${check}/steps/4/logs`,
      stamp + '[command]/usr/bin/git log -1 --format=%H\n' + stamp + sha('d') + '\n'
    );
  }
  const content = (s: string) => ({
    encoding: 'base64',
    content: Buffer.from(s).toString('base64'),
  });
  data.set(
    `${root}/contents/.github/workflows/ci.yml?ref=${sha('a')}`,
    content(
      'on:\n  pull_request:\n    types: [opened, edited]\njobs:\n  manifest:\n    uses: thinmansoftware/bdc-ci/.github/workflows/manifest-validate.yml@v0.1.1\n'
    )
  );
  data.set(
    `${root}/contents/.github/workflows/ci.yml?ref=${sha('e')}`,
    data.get(`${root}/contents/.github/workflows/ci.yml?ref=${sha('a')}`)
  );
  data.set(
    `repos/thinmansoftware/bdc-ci/contents/.github/workflows/manifest-validate.yml?ref=${sha('c')}`,
    content(source)
  );
  data.set(`${root}/git/commits/${sha('e')}`, {
    sha: sha('e'),
    parents: [{ sha: sha('f') }, { sha: sha('a') }],
  });
  data.set(`${root}/pulls/7`, {
    number: 7,
    state: 'open',
    head: { sha: sha('a'), repo: { id: 1 } },
    base: { repo: { id: 1 } },
    body,
  });
  text.set(
    `${root}/actions/jobs/31/steps/6/logs`,
    stamp +
      '##[group]Run ' +
      rendered +
      '\n' +
      stamp +
      '\u001b[36;1m' +
      rendered +
      '\u001b[0m\n' +
      stamp +
      'shell: /usr/bin/bash -e {0}\n' +
      stamp +
      'env:\n' +
      stamp +
      '  PR_BODY: ' +
      body +
      '\n' +
      stamp +
      '  GREP_RUNNER: /home/runner/work/example/example/.bdc-ci/scripts/run-grep-assertions.sh\n' +
      stamp +
      '##[endgroup]\n' +
      stamp +
      'RESULT: PASS (12 checks passed)\n' +
      stamp +
      '===========================================\n'
  );
  return {
    data,
    text,
    root,
    run: () =>
      collectEvidenceRepairReceipt(
        {
          repository: repo,
          repositoryId: 1,
          pr: 7,
          repairHead: sha('a'),
          originalCheckId: 30,
          newCheckId: 31,
          publishedBody: body,
        },
        {
          json: async path => {
            if (!data.has(path)) throw Error('missing');
            return data.get(path);
          },
          text: async path => {
            if (!text.has(path)) throw Error('missing');
            return text.get(path)!;
          },
          localHead: async () => sha('a'),
        }
      ),
  };
}
describe('authoritative evidence repair collection', () => {
  test('joins actual records and consumed step input', async () =>
    expect((await fixture().run()).state).toBe('verified'));
  test('unreadable logs hand off without exposing error', async () => {
    const f = fixture();
    f.text.clear();
    expect((await f.run()).state).toBe('unknown');
  });
  test('stale same-head consumed body fails', async () => {
    const f = fixture();
    const p = `${f.root}/actions/jobs/31/steps/6/logs`;
    f.text.set(p, f.text.get(p)!.replace(body, 'different corrected evidence\n'));
    expect((await f.run()).state).toBe('unknown');
  });
  test('caller without edited support hands off', async () => {
    const f = fixture();
    f.data.set(`${f.root}/contents/.github/workflows/ci.yml?ref=${sha('a')}`, {
      encoding: 'base64',
      content: Buffer.from('on: [pull_request]\njobs: {}').toString('base64'),
    });
    expect((await f.run()).state).toBe('unknown');
  });
  test('actual scripts drift fails', async () => {
    const f = fixture();
    f.text.set(
      `${f.root}/actions/jobs/31/steps/4/logs`,
      stamp + '[command]/usr/bin/git log -1 --format=%H\n' + stamp + sha('b') + '\n'
    );
    expect((await f.run()).state).toBe('unknown');
  });
});

for (const [endpoint, key, value] of [
  ['check-runs/31', 'app', { id: 42 }],
  ['check-runs/31', 'conclusion', 'neutral'],
  ['check-runs/31', 'head_sha', sha('b')],
  ['check-runs/31', 'details_url', 'https://attacker.invalid/logs'],
  ['actions/jobs/31', 'run_attempt', 2],
  ['actions/jobs/31', 'check_run_url', 'https://api.github.com/repos/other/repo/check-runs/31'],
  ['actions/runs/11/attempts/1', 'check_suite_id', 999],
  ['actions/runs/11/attempts/1', 'repository', { id: 2, full_name: repo }],
  ['actions/runs/11/attempts/1', 'pull_requests', []],
  ['pulls/7', 'head', { sha: sha('b'), repo: { id: 1 } }],
  ['pulls/7', 'body', 'changed evidence'],
  [`git/commits/${sha('e')}`, 'parents', [{ sha: sha('b') }, { sha: sha('a') }]],
] as const) {
  test(`collector rejects ${endpoint} ${key}`, async () => {
    const f = fixture();
    const path = `${f.root}/${endpoint}`;
    f.data.set(path, { ...(f.data.get(path) as object), [key]: value });
    expect((await f.run()).state).toBe('unknown');
  });
}
test('collector refuses failed validation step even if check green', async () => {
  const f = fixture();
  const path = `${f.root}/actions/jobs/31`;
  const job = f.data.get(path) as { steps: Array<{ name: string; conclusion: string }> };
  job.steps.find(item => item.name === 'Validate manifest v2 block')!.conclusion = 'failure';
  expect((await f.run()).state).toBe('unknown');
});

test('collector refuses a preamble-only truncated download after exact input', async () => {
  const f = fixture();
  const path = `${f.root}/actions/jobs/31/steps/6/logs`;
  const log = f.text.get(path)!;
  f.text.set(path, log.slice(0, log.indexOf(stamp + 'RESULT:')));
  expect((await f.run()).state).toBe('unknown');
});
test('collector rejects equal-length stale input despite current matching PR body', async () => {
  const f = fixture();
  const path = `${f.root}/actions/jobs/31/steps/6/logs`;
  f.text.set(path, f.text.get(path)!.replace(body, 'x' + body.slice(1)));
  expect((await f.run()).state).toBe('unknown');
});
test('collector rejects caller source changed in actual merge checkout', async () => {
  const f = fixture();
  f.data.set(`${f.root}/contents/.github/workflows/ci.yml?ref=${sha('e')}`, {
    encoding: 'base64',
    content: Buffer.from('different caller').toString('base64'),
  });
  expect((await f.run()).state).toBe('unknown');
});

test('multiple associated PRs are ambiguous event identity', async () => {
  const f = fixture();
  const path = `${f.root}/actions/runs/11/attempts/1`;
  const run = f.data.get(path) as { pull_requests: Array<Record<string, unknown>> };
  run.pull_requests.push({ ...run.pull_requests[0], number: 8 });
  expect((await f.run()).state).toBe('unknown');
});
