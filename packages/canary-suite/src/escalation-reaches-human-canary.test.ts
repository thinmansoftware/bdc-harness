import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { closeDatabase, resetDatabase } from '@archon/core/db';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import {
  deliverNeedsHumanToOperator,
  deliverNeedsHumanViaNotion,
  runEscalationReachesHumanCanary,
} from './escalation-reaches-human-canary';

describe.serial('C3 escalation-reaches-human canary', () => {
  let home = '';
  const originalHome = process.env.ARCHON_HOME;
  const originalUrl = process.env.DATABASE_URL;
  const originalNotion = process.env.NOTION_API_KEY;

  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    home = join(import.meta.dir, `.archon-c3-${Date.now()}-${Math.random()}`);
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
    delete process.env.NOTION_API_KEY;
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (originalHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalHome;
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalNotion === undefined) delete process.env.NOTION_API_KEY;
    else process.env.NOTION_API_KEY = originalNotion;
    removeTempDirWithRetry(home);
  });

  test('GREEN: needs_human writes a human artifact and never calls Notion', async () => {
    const urls: string[] = [];
    const fetcher: typeof fetch = async input => {
      urls.push(String(input));
      return new Response('{}', { status: 200 });
    };
    const result = await runEscalationReachesHumanCanary({
      fetcher,
      deliver: deliverNeedsHumanToOperator,
    });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
    expect(urls.some(url => url.includes('api.notion.com'))).toBe(false);
    expect(urls.some(url => url.includes('c3-canary.invalid'))).toBe(true);
  });

  test('RED: pointing deliver at the Notion-writing path fails loud', async () => {
    const fetcher: typeof fetch = async input => {
      if (String(input).includes('/query')) {
        return Response.json({ results: [{ id: 'c3-notion-page' }] });
      }
      return new Response('{}', { status: 200 });
    };
    const result = await runEscalationReachesHumanCanary({
      fetcher,
      deliver: deliverNeedsHumanViaNotion,
    });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c3_escalation_notion_write_attempted');
  });
});
