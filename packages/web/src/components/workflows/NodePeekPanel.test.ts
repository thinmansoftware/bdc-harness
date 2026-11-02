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
import {
  parseFindingsFromMessage,
  unresolvedFindings,
  isApproveWithFixDisabled,
} from './NodePeekPanel';
import type { GateFinding, GradedVerb } from './NodePeekPanel';
import { approveWorkflowRun } from '@/lib/api';

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

// ---- ISSUE 3: approve-with-fix disabled predicate ----
// Disabled when there are zero unresolved findings (empty ledger OR all resolved).

describe('isApproveWithFixDisabled (approve-with-fix disabled predicate)', () => {
  it('is disabled (true) when the findings list is empty', () => {
    expect(isApproveWithFixDisabled([])).toBe(true);
  });

  it('is disabled (true) when an empty findings ledger parsed from message', () => {
    const findings = parseFindingsFromMessage('plain text, no ledger');
    expect(findings).toEqual([]);
    expect(isApproveWithFixDisabled(findings)).toBe(true);
  });

  it('is disabled (true) when ALL findings are resolved', () => {
    const findings: GateFinding[] = [
      { id: 'f1', label: 'One', resolved: true },
      { id: 'f2', label: 'Two', resolved: true },
    ];
    expect(unresolvedFindings(findings)).toEqual([]);
    expect(isApproveWithFixDisabled(findings)).toBe(true);
  });

  it('is enabled (false) when at least one finding is unresolved', () => {
    const findings: GateFinding[] = [
      { id: 'f1', label: 'One', resolved: true },
      { id: 'f2', label: 'Two', resolved: false },
    ];
    expect(unresolvedFindings(findings).map(f => f.id)).toEqual(['f2']);
    expect(isApproveWithFixDisabled(findings)).toBe(false);
  });
});

// ===========================================================================
// ISSUE 2: approve-with-fix POSTs the authorized_fix_ids of the checked findings.
//
// packages/web has no @testing-library/react, so we cannot mount the component
// and click checkboxes. Mirroring the existing "Scenario 7" cancelWorkflowRun
// fetch-capture idiom (negan-diagnostics.test.ts:419), we mock globalThis.fetch
// to capture the request body and invoke approveWorkflowRun with the same
// options the approve-with-fix button builds:
//   approveWorkflowRun(runId, undefined, {
//     decision_verb: 'approve_with_fix',
//     authorized_fix_ids: Array.from(checkedFixIds),
//   })
// The component's checkedFixIds set is exactly the CHECKED finding ids; this
// test asserts those ids reach the /approve wire body verbatim.
// ===========================================================================
describe('ISSUE 2: approve-with-fix POSTs decision_verb + authorized_fix_ids on the wire', () => {
  it('sends decision_verb=approve_with_fix and the checked fix ids in the POST body', async () => {
    const captured: { url: string; method: string; body: unknown }[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return new Response(JSON.stringify({ success: true, message: 'approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      // The two CHECKED finding ids (mirrors Array.from(checkedFixIds)).
      const checkedIds = ['f1', 'f3'];
      const result = await approveWorkflowRun('run-xyz-789', undefined, {
        decision_verb: 'approve_with_fix',
        authorized_fix_ids: checkedIds,
      });

      expect(captured.length).toBe(1);
      expect(captured[0].method).toBe('POST');
      expect(captured[0].url).toContain('/api/workflows/runs/');
      expect(captured[0].url).toContain('run-xyz-789');
      expect(captured[0].url).toContain('/approve');

      const body = captured[0].body as {
        decision_verb?: string;
        authorized_fix_ids?: string[];
      };
      expect(body.decision_verb).toBe('approve_with_fix');
      expect(body.authorized_fix_ids).toEqual(['f1', 'f3']);

      expect(result.success).toBe(true);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('sends an empty authorized_fix_ids array when no findings are checked', async () => {
    const captured: { body: unknown }[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      captured.push({
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return new Response(JSON.stringify({ success: true, message: 'approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await approveWorkflowRun('run-xyz-789', undefined, {
        decision_verb: 'approve_with_fix',
        authorized_fix_ids: [],
      });
      const body = captured[0].body as {
        decision_verb?: string;
        authorized_fix_ids?: string[];
      };
      expect(body.decision_verb).toBe('approve_with_fix');
      expect(body.authorized_fix_ids).toEqual([]);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ===========================================================================
// ISSUE 1 (wire verification): the LEGACY binary Approve path must send the
// ORIGINAL wire body -- no decision_verb, no authorized_fix_ids. The binary
// button calls approveWorkflowRun(runId) with no options. This asserts that
// call shape produces a body with neither graded field present.
// ===========================================================================
describe('ISSUE 1: legacy binary approve sends the original wire body (no decision_verb)', () => {
  it('approveWorkflowRun(runId) omits decision_verb and authorized_fix_ids', async () => {
    const captured: { body: unknown }[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      captured.push({
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return new Response(JSON.stringify({ success: true, message: 'approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await approveWorkflowRun('run-legacy-1');
      const body = captured[0].body as Record<string, unknown>;
      expect('decision_verb' in body).toBe(false);
      expect('authorized_fix_ids' in body).toBe(false);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
