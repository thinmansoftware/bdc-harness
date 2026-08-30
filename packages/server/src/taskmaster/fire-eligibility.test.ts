import { describe, expect, test } from 'bun:test';
import { checkFireEligibility } from './fire-eligibility';

const TITLE = 'P0: WO-HARNESS-EXAMPLE-01 needs building';
const SPEC = `cauldron_compatible: true\ntarget_repo: thinmansoftware/bdc-harness\n`;

function response(body: unknown, status = 200, remaining = '100'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'x-ratelimit-remaining': remaining },
  });
}

function deps(spec = SPEC, prs: unknown[] = []) {
  return {
    now: () => new Date('2026-08-24T10:00:00.000Z'),
    codebases: async () => [
      {
        name: 'thinmansoftware/bdc-harness',
        repository_url: 'https://github.com/thinmansoftware/bdc-harness.git',
      },
    ],
    fetchImpl: async (url: string | URL | Request) =>
      String(url).includes(`/contents/docs/superpowers/specs/${TITLE.match(/WO-[A-Z0-9-]+/)?.[0]}.md`)
        ? response({ encoding: 'base64', content: Buffer.from(spec).toString('base64') })
        : response({ items: prs }),
  };
}

describe('checkFireEligibility', () => {
  test('accepts a compatible spec with a registered project and no PR', async () => {
    const result = await checkFireEligibility(TITLE, deps());
    expect(result.eligible).toBe(true);
    expect(result.evidence?.project).toBe('bdc-harness');
    expect(result.evidence?.specSource).toBe('repo-path');
  });

  test('fails closed for missing spec, incompatible spec, or existing PR', async () => {
    const missing = deps();
    missing.fetchImpl = async url =>
      String(url).includes('/search/issues') ? response({ items: [] }) : response({}, 404);
    expect((await checkFireEligibility(TITLE, missing)).reason).toBe('spec_missing');
    expect((await checkFireEligibility(TITLE, deps('cauldron_compatible: false'))).reason).toBe(
      'cauldron_incompatible'
    );
    expect(
      (
        await checkFireEligibility(
          TITLE,
          deps(SPEC, [{ title: 'WO-HARNESS-EXAMPLE-01', state: 'open', pull_request: {} }])
        )
      ).reason
    ).toBe('pr_exists');
  });

  test('fails closed when target repo is absent or is not a registered project', async () => {
    expect((await checkFireEligibility(TITLE, deps('cauldron_compatible: true'))).reason).toBe(
      'target_repo_missing'
    );
    const unregistered = deps();
    unregistered.codebases = async () => [];
    expect((await checkFireEligibility(TITLE, unregistered)).reason).toBe('project_not_registered');
  });

  test('does not treat adjacent or prefix WO tokens as the requested WO', async () => {
    for (const title of ['WO-HARNESS-EXAMPLE-010', 'WO-HARNESS-EXAMPLE-1']) {
      const result = await checkFireEligibility(
        TITLE,
        deps(SPEC, [{ title, state: 'open', pull_request: {} }])
      );
      expect(result.eligible).toBe(true);
    }
  });

  test('backs off at the shared GitHub rate-limit floor', async () => {
    const limited = deps();
    limited.fetchImpl = async () => response({}, 200, '4');
    await expect(checkFireEligibility(TITLE, limited)).rejects.toThrow('rate_limit_backoff');
  });

  test('uses a date-prefixed repo spec before the issue-body fallback', async () => {
    const seen: string[] = [];
    const configured = deps();
    configured.fetchImpl = async url => {
      const value = String(url);
      seen.push(value);
      if (value.includes(`/contents/docs/superpowers/specs/${TITLE.match(/WO-[A-Z0-9-]+/)?.[0]}.md`))
        return response({}, 404);
      if (value.endsWith('/contents/docs/superpowers/specs?ref=main'))
        return response([{ name: '2026-08-24-WO-HARNESS-EXAMPLE-01.md', url: 'https://spec.test/date' }]);
      if (value === 'https://spec.test/date')
        return response({ encoding: 'base64', content: Buffer.from(SPEC).toString('base64') });
      return response({ items: [] });
    };
    const result = await checkFireEligibility(TITLE, configured);
    expect(result.evidence?.specSource).toBe('date-glob');
    expect(seen.some(url => url.includes('in%3Atitle'))).toBe(false);
  });

  test('accepts issue-body-only specs and records the same resolving source', async () => {
    const configured = deps();
    configured.fetchImpl = async url => {
      const value = String(url);
      if (value.includes('/contents/')) return response({}, 404);
      if (value.includes('repo%3Athinmansoftware%2Fbdc-xo'))
        return response({ items: [{ number: 208, title: TITLE }] });
      if (value.endsWith('/issues/208')) return response({ body: SPEC });
      return response({ items: [] });
    };
    const result = await checkFireEligibility(TITLE, configured);
    expect(result.eligible).toBe(true);
    expect(result.evidence?.specSource).toBe('issue-body');
  });
});
