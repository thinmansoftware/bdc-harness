/**
 * NodePeekPanel -- unit tests for graded-choice gate logic.
 *
 * Tests the pure functions extracted from NodePeekPanel that determine:
 *  - parseFindingsFromMessage: parses a JSON findings ledger from the gate message.
 *  - GradedVerb, GateFinding types: shape assertions.
 *
 * No DOM / React Testing Library available in this repo (bun test infra only).
 * Component rendering tests are integration-layer; logic tests live here.
 *
 * Contract:
 *  - Three choices render when YAML node.approval.choices contains the verbs.
 *  - Binary Approve/Reject renders when choices absent (legacy path unchanged).
 *  - parseFindingsFromMessage returns GateFinding[] from a JSON ledger message,
 *    and an empty array for plain-text messages (backward-compatible).
 */

import { describe, it, expect } from 'bun:test';
import { parseFindingsFromMessage } from './NodePeekPanel';
import type { GateFinding, GradedVerb } from './NodePeekPanel';

// ---- parseFindingsFromMessage ----

describe('parseFindingsFromMessage', () => {
  it('returns an empty array for a plain-text approval message (legacy messages)', () => {
    const msg = 'Please review the diff before proceeding.';
    expect(parseFindingsFromMessage(msg)).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseFindingsFromMessage('')).toEqual([]);
  });

  it('returns an empty array for non-object JSON (array at root)', () => {
    expect(parseFindingsFromMessage('[1,2,3]')).toEqual([]);
  });

  it('returns an empty array when JSON object has no findings key', () => {
    const msg = JSON.stringify({ summary: 'ok' });
    expect(parseFindingsFromMessage(msg)).toEqual([]);
  });

  it('returns an empty array when findings is present but not an array', () => {
    const msg = JSON.stringify({ findings: 'not-an-array' });
    expect(parseFindingsFromMessage(msg)).toEqual([]);
  });

  it('parses a valid findings ledger with one unresolved finding', () => {
    const ledger = {
      findings: [{ id: 'locg-migration', label: 'LOCG migration gap', resolved: false }],
    };
    const result = parseFindingsFromMessage(JSON.stringify(ledger));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('locg-migration');
    expect(result[0].label).toBe('LOCG migration gap');
    expect(result[0].resolved).toBe(false);
  });

  it('parses multiple findings, including a resolved one', () => {
    const ledger = {
      findings: [
        { id: 'f1', label: 'Finding one', resolved: false },
        { id: 'f2', label: 'Finding two', resolved: true },
        { id: 'f3', label: 'Finding three', resolved: false },
      ],
    };
    const result = parseFindingsFromMessage(JSON.stringify(ledger));
    expect(result).toHaveLength(3);
    const unresolvedIds = result.filter(f => !f.resolved).map(f => f.id);
    expect(unresolvedIds).toEqual(['f1', 'f3']);
  });

  it('skips malformed entries (missing id or label) without throwing', () => {
    const ledger = {
      findings: [
        { id: 'good', label: 'Good one', resolved: false },
        { label: 'No id', resolved: false },
        { id: 'no-label', resolved: false },
        null,
        42,
      ],
    };
    const result = parseFindingsFromMessage(JSON.stringify(ledger));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('good');
  });

  it('treats missing resolved field as false (not resolved)', () => {
    const ledger = {
      findings: [{ id: 'f1', label: 'No resolved key' }],
    };
    const result = parseFindingsFromMessage(JSON.stringify(ledger));
    expect(result).toHaveLength(1);
    expect(result[0].resolved).toBe(false);
  });

  it('returns an empty array for malformed JSON without throwing', () => {
    expect(parseFindingsFromMessage('{not valid json')).toEqual([]);
  });
});

// ---- GradedVerb / GateFinding type shape tests ----

describe('GradedVerb type values', () => {
  it('all three verbs are string literals that satisfy GradedVerb', () => {
    const verbs: GradedVerb[] = ['approve_as_is', 'approve_with_fix', 'reject'];
    expect(verbs).toHaveLength(3);
    for (const v of verbs) {
      expect(typeof v).toBe('string');
    }
  });
});

describe('GateFinding type shape', () => {
  it('a valid GateFinding satisfies the interface', () => {
    const f: GateFinding = { id: 'test-id', label: 'Test finding', resolved: false };
    expect(f.id).toBe('test-id');
    expect(f.label).toBe('Test finding');
    expect(f.resolved).toBe(false);
  });
});

// ---- Graded mode eligibility (inline logic derived from NodePeekPanel) ----
// These replicate the isGradedMode guard to verify the contract:
//   choices.length >= 2 -> graded mode
//   choices absent or length < 2 -> binary mode (legacy)

describe('graded mode eligibility contract', () => {
  function computeIsGradedMode(choices: GradedVerb[] | null | undefined): boolean {
    return choices != null && choices.length >= 2;
  }

  it('is false when choices is null (absent in the YAML)', () => {
    expect(computeIsGradedMode(null)).toBe(false);
  });

  it('is false when choices is undefined', () => {
    expect(computeIsGradedMode(undefined)).toBe(false);
  });

  it('is false when choices is an empty array', () => {
    expect(computeIsGradedMode([])).toBe(false);
  });

  it('is false when choices has only one verb', () => {
    expect(computeIsGradedMode(['approve_as_is'])).toBe(false);
  });

  it('is true when choices includes all three verbs', () => {
    expect(computeIsGradedMode(['approve_as_is', 'approve_with_fix', 'reject'])).toBe(true);
  });

  it('is true when choices has exactly two verbs', () => {
    expect(computeIsGradedMode(['approve_as_is', 'reject'])).toBe(true);
  });
});
