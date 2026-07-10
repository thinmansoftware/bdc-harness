import { describe, expect, test } from 'bun:test';
import { escalateCriticalFindings, JOHN_TELEGRAM_CHAT_ID } from './escalate';
import { cleanFinding, criticalFinding } from './test-fixtures';
import type { ScanReport } from './types';

function report(findings = [criticalFinding]): ScanReport {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    generatedAt: new Date(0).toISOString(),
    verdict: findings.some(finding => finding.severity === 'CRITICAL') ? 'CRITICAL' : 'CLEAN',
    findings,
    reasonCodes: findings.map(finding => finding.reason_code),
  };
}

describe('escalateCriticalFindings', () => {
  test('sends Telegram for CRITICAL findings', async () => {
    const sent: string[] = [];
    const count = await escalateCriticalFindings(report(), {
      token: 'test-token',
      sender: async message => {
        expect(message.chatId).toBe(JOHN_TELEGRAM_CHAT_ID);
        sent.push(message.text);
      },
    });
    expect(count).toBe(1);
    expect(sent[0]).toContain('CRITICAL');
  });

  test('does not send Telegram for CLEAN findings', async () => {
    let called = false;
    const count = await escalateCriticalFindings(report([cleanFinding]), {
      token: 'test-token',
      sender: async () => {
        called = true;
      },
    });
    expect(count).toBe(0);
    expect(called).toBe(false);
  });
});
