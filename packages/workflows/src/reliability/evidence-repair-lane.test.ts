import { expect, test } from 'bun:test';
import { evidenceRepairLane, type EvidenceLaneDeps } from './evidence-repair-lane';
import { createHash } from 'node:crypto';
const head = 'a'.repeat(40);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const snapshot = {
  state: 'captured',
  repository: 'thinmansoftware/example',
  repositoryId: 1,
  pr: 7,
  repairHead: head,
  originalCheckId: 30,
  originalBodyHash: hash('old body'),
};
function fixture() {
  const files = new Map<string, string>([
    ['implement.env', 'COMPLETE=true\nALREADY_SATISFIED=no\nEVIDENCE_ONLY_REPAIR=yes\n'],
    ['body', 'corrected body'],
  ]);
  let currentHead = head;
  let dirty = '';
  const deps: EvidenceLaneDeps = {
    localHead: async () => currentHead,
    git: async args =>
      args[0] === 'status' ? dirty : 'https://github.com/thinmansoftware/example.git\n',
    json: async path =>
      path.endsWith('/pulls/7')
        ? {
            number: 7,
            state: 'open',
            head: { sha: currentHead, repo: { id: 1 } },
            body: 'old body',
          }
        : path.endsWith('check-runs?filter=all&per_page=100')
          ? {
              total_count: 1,
              check_runs: [
                {
                  id: 30,
                  name: 'manifest-validate / manifest-validate',
                  app: { id: 15368 },
                  head_sha: head,
                  status: 'completed',
                  conclusion: 'failure',
                },
              ],
            }
          : { id: 1, full_name: 'thinmansoftware/example' },
    text: async () => {
      throw Error('unavailable');
    },
    read: async name => {
      if (!files.has(name)) throw Error('missing');
      return files.get(name)!;
    },
    write: async (name, value) => {
      files.set(name, value);
    },
  };
  return {
    files,
    deps,
    setHead: (s: string) => {
      currentHead = s;
    },
    setDirty: (s: string) => {
      dirty = s;
    },
    run: (stage: string, input = JSON.stringify(snapshot), bodyFile?: string) =>
      evidenceRepairLane(stage, input, deps, bodyFile),
  };
}
test('captures canonical repair lease and actual original failure', async () =>
  expect(
    (await fixture().run('capture', `REPAIR_TARGET=#7\nREPAIR_TARGET_LEASE_SHA=${head}\n`)).state
  ).toBe('captured'));
test('classifies evidence-only completion without real-build claim', async () =>
  expect((await fixture().run('classify')).state).toBe('evidence_only'));
test('changed repair head explicitly hands off', async () => {
  const f = fixture();
  f.setHead('b'.repeat(40));
  expect((await f.run('classify')).state).toBe('unknown');
});
test('dirty repair explicitly hands off', async () => {
  const f = fixture();
  f.setDirty(' M source.ts');
  expect((await f.run('classify')).state).toBe('unknown');
});
test('legacy no-op ending cannot bypass proof', async () => {
  const f = fixture();
  f.files.set('implement.env', 'COMPLETE=true\nALREADY_SATISFIED=yes\n');
  expect((await f.run('classify')).state).toBe('unknown');
});
test('missing completion hands off', async () => {
  const f = fixture();
  f.files.delete('implement.env');
  expect((await f.run('classify')).state).toBe('unknown');
});
test('evidence declaration without repair target hands off', async () =>
  expect((await fixture().run('classify', '{"state":"not_applicable"}')).state).toBe('unknown'));
test('ordinary build with no evidence declaration is preserved', async () => {
  const f = fixture();
  f.files.set('implement.env', 'COMPLETE=true\nALREADY_SATISFIED=no\n');
  expect((await f.run('classify', '{"state":"not_applicable"}')).state).toBe('ordinary');
});
test('publication preserves full bytes plus excluded old check identities', async () => {
  const f = fixture();
  const result = await f.run('publication', undefined, 'body');
  expect(result.state).toBe('published');
  expect(f.files.get('evidence-repair-published-body')).toBe('corrected body');
  expect(result).toHaveProperty('priorCheckIds', [30]);
});
test('unchanged evidence cannot be called corrected', async () => {
  const f = fixture();
  f.files.set('body', 'old body');
  expect((await f.run('publication', undefined, 'body')).state).toBe('unknown');
});
test('missing publication receipt hands off', async () =>
  expect((await fixture().run('verify')).state).toBe('unknown'));
test('body artifact substitution fails hash binding', async () => {
  const f = fixture();
  f.files.set('evidence-repair-published-body', 'forged');
  f.files.set(
    'node-out/patch-pr-body.out',
    'EVIDENCE_PUBLICATION=' +
      JSON.stringify({ state: 'published', sha256: hash('corrected body'), priorCheckIds: [30] })
  );
  expect((await f.run('verify')).state).toBe('unknown');
});
test('old green or failed check cannot substitute new publication invocation', async () => {
  const f = fixture();
  f.files.set('evidence-repair-published-body', 'corrected body');
  f.files.set(
    'node-out/patch-pr-body.out',
    'EVIDENCE_PUBLICATION=' +
      JSON.stringify({ state: 'published', sha256: hash('corrected body'), priorCheckIds: [30] })
  );
  expect((await f.run('verify')).state).toBe('pending');
});
