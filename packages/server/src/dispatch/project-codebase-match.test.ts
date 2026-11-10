import { describe, expect, it } from 'bun:test';
import { matchProjectCodebase } from './project-codebase-match';

// T3 fire commands name a project the way fire.ps1 and fire-eligibility do: the bare
// repo name ('bdc-xo'). Registered codebases are named 'owner/repo'
// ('thinmansoftware/bdc-xo'). Live 2026-11-09 (bdc-xo#4311 Test 10): every T3 fire
// got 400 project_not_registered because the resolver required name === project.
const codebases = [
  {
    name: 'thinmansoftware/bdc-xo',
    repository_url: 'https://github.com/thinmansoftware/bdc-xo.git',
  },
  {
    name: 'thinmansoftware/bdc-harness',
    repository_url: 'https://github.com/thinmansoftware/bdc-harness',
  },
  { name: 'thinmansoftware/shopops', repository_url: null },
];

describe('matchProjectCodebase', () => {
  it('resolves a bare repo name to its unique owner/repo codebase', () => {
    expect(matchProjectCodebase(codebases, 'bdc-xo')?.name).toBe('thinmansoftware/bdc-xo');
  });

  it('still resolves an exact owner/repo name', () => {
    expect(matchProjectCodebase(codebases, 'thinmansoftware/bdc-harness')?.name).toBe(
      'thinmansoftware/bdc-harness'
    );
  });

  it('prefers an exact name over a bare-name match', () => {
    const rows = [{ name: 'bdc-xo', repository_url: null }, ...codebases];
    expect(matchProjectCodebase(rows, 'bdc-xo')?.name).toBe('bdc-xo');
  });

  it('fails closed when a bare name matches two owners', () => {
    const rows = [...codebases, { name: 'someone-else/bdc-xo', repository_url: null }];
    expect(matchProjectCodebase(rows, 'bdc-xo')).toBeUndefined();
  });

  it('returns undefined for an unknown project and never matches by substring', () => {
    expect(matchProjectCodebase(codebases, 'xo')).toBeUndefined();
    expect(matchProjectCodebase(codebases, 'nope')).toBeUndefined();
    expect(matchProjectCodebase(codebases, '')).toBeUndefined();
  });

  it('is case-insensitive like normalizeRepo', () => {
    expect(matchProjectCodebase(codebases, 'BDC-XO')?.name).toBe('thinmansoftware/bdc-xo');
  });
});
