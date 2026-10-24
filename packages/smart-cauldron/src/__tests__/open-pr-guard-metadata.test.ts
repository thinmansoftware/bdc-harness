import { expect, test } from 'bun:test';
import {
  createDefaultOpenPrGuardLookup,
  createGhLanePrFetcher,
  findBlockingOpenPrs,
} from '../open-pr-guard';

const WO = 'WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01';
const target = { owner: 'thinmansoftware', repo: 'bdc-harness', prNumber: 55 };
const valid = {
  number: 55,
  state: 'OPEN',
  title: WO,
  body: '',
  url: 'https://github.com/thinmansoftware/bdc-harness/pull/55',
  headRefName: 'feat/repair',
  headRefOid: 'a'.repeat(40),
  isCrossRepository: false,
  reviewDecision: 'CHANGES_REQUESTED',
  createdAt: '2026-10-24T10:00:00Z',
};

for (const stdout of [
  '',
  '{}',
  'null',
  '[null]',
  '[{}]',
  JSON.stringify([{ ...valid, number: -1 }]),
  JSON.stringify([{ ...valid, state: 'UNKNOWN' }]),
  JSON.stringify([{ ...valid, url: 'https://github.com/other/repo/pull/55' }]),
]) {
  test(`malformed OPEN listing refuses with bounded retry: ${stdout}`, async () => {
    let calls = 0;
    const lookup = createDefaultOpenPrGuardLookup(async () => null, (async () => {
      calls++;
      return { stdout, stderr: '' };
    }) as never);
    let failure: unknown;
    try {
      await findBlockingOpenPrs({
        woId: WO,
        project: 'bdc-harness',
        attemptRunIds: [],
        lookup,
        retryDelayMs: 0,
        sleep: async () => {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(calls).toBe(2);
  });
}

for (const patch of [
  { number: 56 },
  { state: undefined },
  { state: 'UNKNOWN' },
  { headRefName: undefined },
  { url: 'https://github.com/other/repo/pull/55' },
]) {
  test(`malformed per-number state refuses: ${JSON.stringify(patch)}`, async () => {
    const lookup = createDefaultOpenPrGuardLookup(async () => null, (async () => ({
      stdout: JSON.stringify({ ...valid, ...patch }),
      stderr: '',
    })) as never);
    let failure: unknown;
    try {
      await lookup.readPr(target);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
  });
}

for (const flag of [undefined, null, 0, 'false']) {
  test(`missing/nonboolean fork proof refuses: ${flag}`, async () => {
    const fetch = createGhLanePrFetcher((async () => ({
      stdout: JSON.stringify({ ...valid, isCrossRepository: flag }),
      stderr: '',
    })) as never);
    let failure: unknown;
    try {
      await fetch(target.owner, target.repo, target.prNumber);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
  });
}

test('valid empty list and explicit live owned identity retain behavior', async () => {
  const lookup = createDefaultOpenPrGuardLookup(async () => null, (async (
    _command: string,
    args: string[]
  ) => ({ stdout: args[1] === 'list' ? '[]' : JSON.stringify(valid), stderr: '' })) as never);
  expect(await lookup.searchOpenPrs('thinmansoftware/bdc-harness', WO)).toEqual([]);
  expect(await lookup.readPr(target)).toMatchObject({ state: 'OPEN', headRef: 'feat/repair' });
  const fetch = createGhLanePrFetcher((async () => ({
    stdout: JSON.stringify(valid),
    stderr: '',
  })) as never);
  expect(await fetch(target.owner, target.repo, target.prNumber)).toMatchObject({
    headRepoFullName: 'thinmansoftware/bdc-harness',
    baseRepoFullName: 'thinmansoftware/bdc-harness',
  });
});

for (const patch of [
  { url: undefined },
  { url: 'https://github.com/foreign/repository/pull/55' },
  { url: 'https://github.com/thinmansoftware/bdc-harness/pull/56' },
  { reviewDecision: undefined },
  { reviewDecision: 'UNVERIFIED' },
]) {
  test(`lane identity and review metadata refuse unknown proof: ${JSON.stringify(patch)}`, async () => {
    const fetch = createGhLanePrFetcher((async () => ({
      stdout: JSON.stringify({ ...valid, ...patch }),
      stderr: '',
    })) as never);
    let failure: unknown;
    try {
      await fetch(target.owner, target.repo, target.prNumber);
    } catch (error) {
      failure = error;
    }
    expect((failure as Error)?.message).toBe('lane_pr_lookup_invalid');
  });
}

for (const reviewDecision of ['', null]) {
  test(`absent approval is normalized without clearing the OPEN blocker: ${reviewDecision}`, async () => {
    const fetch = createGhLanePrFetcher((async () => ({
      stdout: JSON.stringify({ ...valid, reviewDecision }),
      stderr: '',
    })) as never);
    const result = await fetch(target.owner, target.repo, target.prNumber);
    expect(result?.reviewDecision).toBeNull();
    const blockers = await findBlockingOpenPrs({
      woId: WO,
      project: 'bdc-harness',
      attemptRunIds: [],
      lookup: {
        searchOpenPrs: async () => [],
        registryAttributedPrs: async () => [target],
        readPr: async () => ({
          state: result!.state,
          headRef: result!.headRefName,
          url: valid.url,
        }),
      },
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0].prNumber).toBe(target.prNumber);
  });
}
