/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 5 — node peek data selection.
 */
import { describe, expect, it } from 'bun:test';
import { selectPeekData } from './node-peek-data';
import type { WorkflowEventResponse } from './api';

let seq = 0;
function ev(
  event_type: string,
  data: Record<string, unknown>,
  step_name = 'diff-review'
): WorkflowEventResponse {
  seq++;
  return {
    id: `ev-${String(seq)}`,
    workflow_run_id: 'run-test',
    event_type,
    step_index: null,
    step_name,
    data,
    created_at: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  };
}

describe('selectPeekData', () => {
  it('returns empty for an empty events array', () => {
    expect(selectPeekData([])).toEqual({});
  });

  it('extracts output from node_completed', () => {
    const events = [ev('node_completed', { node_output: 'review passed' })];
    expect(selectPeekData(events).output).toBe('review passed');
  });

  it('extracts output from node_completed_with_warning too', () => {
    const events = [ev('node_completed_with_warning', { node_output: 'review warned' })];
    expect(selectPeekData(events).output).toBe('review warned');
  });

  it('extracts error from node_failed', () => {
    const events = [ev('node_failed', { error: 'codex 400 model not supported' })];
    expect(selectPeekData(events).error).toBe('codex 400 model not supported');
  });

  it('extracts prompt from node_started when present', () => {
    const events = [ev('node_started', { prompt: 'review the diff' })];
    expect(selectPeekData(events).prompt).toBe('review the diff');
  });

  it('extracts diff from any event that carries it', () => {
    const events = [ev('node_completed', { node_output: 'ok', diff: '+++ b/foo\n@@\n+x' })];
    const out = selectPeekData(events);
    expect(out.output).toBe('ok');
    expect(out.diff).toBe('+++ b/foo\n@@\n+x');
  });

  it('falls back to undefined for missing fields without crashing', () => {
    const events = [ev('node_started', {})];
    const out = selectPeekData(events);
    expect(out.prompt).toBeUndefined();
    expect(out.output).toBeUndefined();
    expect(out.error).toBeUndefined();
    expect(out.diff).toBeUndefined();
  });
});
