import { afterEach, describe, expect, test } from 'bun:test';
import { Octokit } from '@octokit/rest';
import { attachGitHubQuotaHooks } from '../adapters/github-real-deps';
import {
  assertGitHubPoolAvailable,
  resetGitHubApiMeterForTests,
} from '@archon/core/github/metering';

afterEach(resetGitHubApiMeterForTests);

describe('Octokit shared installation quota', () => {
  for (const resource of ['search', 'graphql']) {
    test(`records rejected ${resource} responses and blocks another service before HTTP`, async () => {
      let requests = 0;
      const fetcher = (async () => {
        requests += 1;
        return Response.json(
          { message: 'API rate limit exceeded' },
          {
            status: 403,
            headers: {
              'x-ratelimit-resource': resource,
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
            },
          }
        );
      }) as typeof fetch;
      const first = new Octokit({ request: { fetch: fetcher } });
      const second = new Octokit({ request: { fetch: fetcher } });
      attachGitHubQuotaHooks(first, 'overseer', 'shared-app');
      attachGitHubQuotaHooks(second, 'merge_manager', 'shared-app');
      const route = resource === 'search' ? 'GET /search/issues' : 'POST /graphql';
      for (const client of [first, second]) {
        let refused: unknown;
        try {
          await client.request(route);
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(Error);
      }
      expect(requests).toBe(1);
      expect(() => assertGitHubPoolAvailable('shared-app', resource)).toThrow(
        'github_pool_backoff'
      );
      expect(() => assertGitHubPoolAvailable('shared-app', 'core')).not.toThrow();
      expect(() => assertGitHubPoolAvailable('different-pool', resource)).not.toThrow();
    });
  }
});
