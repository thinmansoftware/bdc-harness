import { describe, expect, test } from 'bun:test';
import { checksVerdict, decideBlocker, reviewVerdict } from '../decide-card';
import fixture from './fixtures/base.json';

const pr = { ...fixture };
describe('merge guard parity and blocker decisions', () => {
  test('1 changes requested on exact head', () => {
    const verdict = reviewVerdict(
      [
        {
          user: { login: 'thinman-overseer[bot]' },
          state: 'CHANGES_REQUESTED',
          commit_id: pr.head_sha,
          submitted_at: '2',
        },
      ],
      pr.head_sha
    );
    expect(verdict).toBe('latest Overseer review is CHANGES_REQUESTED');
    expect(
      decideBlocker({ pr, reviewVerdict: verdict, checksVerdict: 'OK', woId: 'WO-X-01', runs: [] })
        .blocker_class
    ).toBe('changes_requested_on_head');
  });
  test('2 stale approval is exact', () => {
    const verdict = reviewVerdict(
      [
        {
          user: { login: 'thinman-overseer[bot]' },
          state: 'APPROVED',
          commit_id: 'oooooooooooo',
          submitted_at: '2',
        },
      ],
      pr.head_sha
    );
    expect(verdict).toBe('latest Overseer review is on oooooooo, head is hhhhhhhh');
    expect(
      decideBlocker({ pr, reviewVerdict: verdict, checksVerdict: 'OK', woId: null, runs: [] })
        .next_permitted_action.action
    ).toBe('await-re-review');
  });
  test('3 red required check verdict', () =>
    expect(
      checksVerdict(
        [{ name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'failure' }],
        []
      )
    ).toBe('checks not green: test (ubuntu-latest)=failure'));
  test('6 production base needs motion', () =>
    expect(
      decideBlocker({
        pr: { ...pr, base_ref: 'master', production_base: true },
        reviewVerdict: 'OK',
        checksVerdict: 'OK',
        woId: null,
        runs: [],
      }).blocker_class
    ).toBe('production_base_needs_motion'));
  test('7 draft and closed precedence', () => {
    expect(
      decideBlocker({
        pr: { ...pr, draft: true },
        reviewVerdict: 'latest Overseer review is CHANGES_REQUESTED',
        checksVerdict: 'OK',
        woId: null,
        runs: [],
      }).blocker_class
    ).toBe('draft');
    expect(
      decideBlocker({
        pr: { ...pr, state: 'MERGED' },
        reviewVerdict: 'OK',
        checksVerdict: 'checks not green: x=failure',
        woId: null,
        runs: [],
      }).blocker_class
    ).toBe('closed');
  });
  test('8 later approval replaces same reviewer request', () => {
    const reviews = [
      {
        user: { login: 'human' },
        state: 'CHANGES_REQUESTED',
        commit_id: pr.head_sha,
        submitted_at: '1',
      },
      { user: { login: 'human' }, state: 'APPROVED', commit_id: pr.head_sha, submitted_at: '2' },
      {
        user: { login: 'thinman-overseer[bot]' },
        state: 'APPROVED',
        commit_id: pr.head_sha,
        submitted_at: '3',
      },
    ];
    expect(reviewVerdict(reviews, pr.head_sha)).toBe('OK');
  });
});
