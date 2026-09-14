import { describe, expect, test } from 'bun:test';
import {
  deliverNeedsHumanToOperator,
  deliverNeedsHumanViaNotion,
  runEscalationReachesHumanCanary,
} from './escalation-reaches-human-canary';

describe('C3 escalation-reaches-human canary', () => {
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
  });

  test('RED: pointing deliver at the Notion-writing path fails loud', async () => {
    const fetcher: typeof fetch = async () => new Response('{}', { status: 200 });
    const result = await runEscalationReachesHumanCanary({
      fetcher,
      deliver: deliverNeedsHumanViaNotion,
    });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c3_escalation_notion_write_attempted');
  });
});
