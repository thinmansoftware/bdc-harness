/**
 * Tests for WO-HARNESS-ESCALATED-RUN-STATUS-01 escalation packet builder.
 *
 * Scenarios:
 * 5. rejection findings marker is in the packet; plain events with no rejection
 *    produce an empty packet
 * 6. oversized rejected diff is truncated first; findings never truncated ahead of
 *    the diff
 */
import { describe, expect, test } from 'bun:test';
import {
  buildEscalationPacket,
  ESCALATION_FINDINGS_MARKER,
  extractPlanText,
  extractRejectedDiff,
  extractRejectionFindings,
  prependEscalationPacket,
} from './escalation-packet-builder';

describe('extractRejectionFindings', () => {
  test('pulls FALLBACK_FLIP_DECLINED and needs_revision text', () => {
    const text = extractRejectionFindings([
      {
        event_type: 'node_completed',
        step_name: 'war-council-validator',
        data: { output: 'verdict needs_revision: money path violated' },
      },
      {
        event_type: 'node_completed',
        step_name: 'flip-notion-on-failure',
        data: {
          output:
            'FALLBACK_FLIP_DECLINED: validator verdict not satisfied; real failure; leaving issue as-is.',
        },
      },
    ]);
    expect(text).not.toBeNull();
    expect(text).toContain('needs_revision');
    expect(text).toContain('FALLBACK_FLIP_DECLINED');
  });

  test('returns null when no rejection signal present', () => {
    expect(
      extractRejectionFindings([
        {
          event_type: 'node_failed',
          step_name: 'implement',
          data: { error: 'OOM killed' },
        },
      ])
    ).toBeNull();
  });
});

describe('extractPlanText', () => {
  test('prefers APPROVED_PLAN fence from plan-review', () => {
    const plan = extractPlanText([
      {
        event_type: 'node_completed',
        step_name: 'plan',
        data: { output: '## Draft\nnot this one' },
      },
      {
        event_type: 'node_completed',
        step_name: 'plan-review',
        data: {
          output:
            'PLAN_REVIEW_PASS=true\n=== APPROVED_PLAN_BEGIN ===\n## File list\n- a.ts\n=== APPROVED_PLAN_END ===\n',
        },
      },
    ]);
    expect(plan).toContain('## File list');
    expect(plan).not.toContain('not this one');
  });
});

describe('extractRejectedDiff', () => {
  test('picks implement output that looks like a diff', () => {
    const diff = extractRejectedDiff([
      {
        event_type: 'node_completed',
        step_name: 'implement',
        data: {
          output: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-foo\n+bar\n',
        },
      },
    ]);
    expect(diff).toContain('diff --git');
  });
});

describe('buildEscalationPacket', () => {
  test('5: packet contains findings marker; empty when no rejection', () => {
    const good = buildEscalationPacket({
      priorRunId: 'abc',
      events: [
        {
          event_type: 'node_completed',
          step_name: 'war-council-validator',
          data: { output: 'needs_revision -- auth world changed' },
        },
      ],
    });
    expect(good.packet).toContain(ESCALATION_FINDINGS_MARKER);
    expect(good.packet).toContain('auth world changed');
    expect(good.included.findings).toBe(true);

    const bad = buildEscalationPacket({
      events: [
        {
          event_type: 'node_failed',
          step_name: 'implement',
          data: { error: 'segfault' },
        },
      ],
    });
    expect(bad.packet).toBe('');
    expect(bad.included.findings).toBe(false);
  });

  test('6: oversized rejected diff is truncated; findings retained in full', () => {
    const findingsBody =
      'needs_revision: CRITICAL money-path regression in checkout.ts -- do not ship';
    const hugeDiff =
      'diff --git a/big.ts b/big.ts\n' +
      Array.from({ length: 5000 }, (_, i) => `+line ${String(i)} of rejected fluff`).join('\n');

    const result = buildEscalationPacket({
      sizeCap: 3_000,
      diffCap: 500,
      events: [
        {
          event_type: 'node_completed',
          step_name: 'war-council-validator',
          data: { output: findingsBody },
        },
        {
          event_type: 'node_completed',
          step_name: 'implement',
          data: { output: hugeDiff },
        },
      ],
    });

    expect(result.packet).toContain(ESCALATION_FINDINGS_MARKER);
    // Findings full text must still be present (never truncated ahead of the diff)
    expect(result.packet).toContain(findingsBody);
    expect(result.diffTruncated).toBe(true);
    // Diff truncated marker or omission message present
    expect(
      result.packet.includes('[diff truncated') ||
        result.packet.includes('omitted: packet size cap') ||
        result.packet.includes('[packet hard-truncated]')
    ).toBe(true);
    // Total packet respects the size cap (allowing small hard-truncate trailer)
    expect(result.packet.length).toBeLessThanOrEqual(3_000 + 40);
  });

  test('prependEscalationPacket is a no-op on empty packet', () => {
    expect(prependEscalationPacket('hello', '')).toBe('hello');
    const combined = prependEscalationPacket('hello', 'PKT');
    expect(combined).toContain('PKT');
    expect(combined).toContain('--- SUCCESSOR USER MESSAGE ---');
    expect(combined).toContain('hello');
  });

  test('invalid JSON event.data does not crash packet build', () => {
    // Codex finding: missing error handling for invalid JSON in event data.
    const result = buildEscalationPacket({
      events: [
        {
          event_type: 'node_completed',
          step_name: 'war-council-validator',
          data: '{not-valid-json needs_revision',
        },
        {
          event_type: 'node_completed',
          step_name: 'flip-notion-on-failure',
          data: null,
        },
      ],
    });
    // Raw string still matched the needs_revision phrase.
    expect(result.packet).toContain(ESCALATION_FINDINGS_MARKER);
    expect(result.packet).toContain('needs_revision');
  });

  test('prependEscalationPacket strips control chars so packet cannot reshape message', () => {
    const combined = prependEscalationPacket('WO_ID=WO-DEMO-01\nprompt', 'PKT\u0000with\u0007bell');
    expect(combined).not.toContain('\u0000');
    expect(combined).not.toContain('\u0007');
    expect(combined).toContain('PKT');
    expect(combined).toContain('WO_ID=WO-DEMO-01');
    expect(combined.indexOf('--- SUCCESSOR USER MESSAGE ---')).toBeGreaterThan(0);
  });
});
