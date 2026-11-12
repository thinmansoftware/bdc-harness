import { describe, expect, test } from 'bun:test';
import { PERSONAL_TOKEN_ENV_NAMES, laneEnv, stripPersonalTokens } from './lane-env';

const personal = {
  GH_TOKEN: 'ghp_x',
  GITHUB_TOKEN: 'ghp_x',
  MERGE_MANAGER_GH_TOKEN: 'ghp_x',
  GH_AUTH_TOKEN_INTERNAL: 'ghp_x',
  ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN: 'ghp_x',
};

describe('lane environment (bdc-xo#5464)', () => {
  test('the list names all five personal-token variables', () => {
    expect([...PERSONAL_TOKEN_ENV_NAMES].sort()).toEqual(Object.keys(personal).sort());
  });

  test('laneEnv removes every personal-token name and keeps the rest', () => {
    const env = laneEnv({ ...personal, PATH: '/usr/bin', GITHUB_APP_RUN_NODES_ID: '5407122' });
    for (const name of PERSONAL_TOKEN_ENV_NAMES) expect(name in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
    // the builder App identity (not a personal token) must stay for the gh shim
    expect(env.GITHUB_APP_RUN_NODES_ID).toBe('5407122');
  });

  test('laneEnv switches the GitHub permission fallback off', () => {
    expect(laneEnv({ PATH: '/usr/bin' }).ARCHON_GITHUB_NO_PERMISSION_FALLBACK).toBe('1');
  });

  test('laneEnv does not mutate its input', () => {
    const base = { ...personal, PATH: '/usr/bin' };
    laneEnv(base);
    expect(base.GH_TOKEN).toBe('ghp_x');
  });

  test('stripPersonalTokens removes names added by a caller after the base was built', () => {
    const merged = stripPersonalTokens({ PATH: '/usr/bin', ...personal, FOO: 'bar' });
    expect(Object.keys(merged).sort()).toEqual(['FOO', 'PATH']);
  });
});
