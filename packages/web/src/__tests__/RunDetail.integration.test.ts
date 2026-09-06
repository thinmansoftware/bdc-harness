/**
 * Integration-level regression for WO-CAULDRON-DASHBOARD-RUN-ID-TRUNCATION-01.
 *
 * Ground truth (live 2026-07-07):
 *   GET /api/workflows/runs/eff9d1e8                                 -> 404
 *   GET /api/workflows/runs/eff9d1e8582a29e2748d4886c85c0218        -> 200
 *
 * The dashboard MAY display a short id for readability, but every navigation
 * target and every graph-hydration API call MUST use the full run id that is
 * already on the row data object.
 */
import { describe, test, expect } from 'bun:test';
import {
  shortRunId,
  workflowRunApiPath,
  workflowRunDetailPath,
} from '@/lib/format';

const FULL_RUN_ID = 'eff9d1e8582a29e2748d4886c85c0218';
const SHORT_DISPLAY = 'eff9d1e8';

describe('RunDetail run-id wiring (integration)', () => {
  test('display path remains short while API/route paths keep the FULL id', () => {
    expect(shortRunId(FULL_RUN_ID)).toBe(SHORT_DISPLAY);
    expect(workflowRunDetailPath(FULL_RUN_ID)).toContain(FULL_RUN_ID);
    expect(workflowRunDetailPath(FULL_RUN_ID)).not.toBe(`/workflows/runs/${SHORT_DISPLAY}`);
    expect(workflowRunApiPath(FULL_RUN_ID)).toBe(`/api/workflows/runs/${FULL_RUN_ID}`);
    // Path ends with the FULL id (short token alone is not the last segment).
    expect(workflowRunApiPath(FULL_RUN_ID).endsWith(`/${FULL_RUN_ID}`)).toBe(true);
    expect(workflowRunApiPath(FULL_RUN_ID).endsWith(`/${SHORT_DISPLAY}`)).toBe(false);
  });

  test('truncated display token is rejected for route + API builders', () => {
    expect(() => workflowRunDetailPath(SHORT_DISPLAY)).toThrow(/truncated display id/);
    expect(() => workflowRunApiPath(SHORT_DISPLAY)).toThrow(/truncated display id/);
  });

  test('click-target evidence: graph fetch URL is built from full id field only', () => {
    // Simulate a dashboard row object that also has a short display helper.
    const row = {
      id: FULL_RUN_ID,
      displayId: shortRunId(FULL_RUN_ID),
    };
    // Correct: use row.id
    const goodRoute = workflowRunDetailPath(row.id);
    const goodApi = workflowRunApiPath(row.id);
    expect(goodRoute).toBe(`/workflows/runs/${FULL_RUN_ID}`);
    expect(goodApi).toBe(`/api/workflows/runs/${FULL_RUN_ID}`);
    // Incorrect: using the display token would have broken the graph view.
    expect(() => workflowRunDetailPath(row.displayId)).toThrow(/truncated display id/);
  });
});
