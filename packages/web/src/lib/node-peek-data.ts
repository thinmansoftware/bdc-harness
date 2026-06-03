/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — NodePeek data selection.
 *
 * Pure: walks a newest-first event list and returns the four fields the
 * NodePeekPanel displays so the operator can read a node without ssh+sqlite.
 *
 * Source field mapping (from remote_agent_workflow_events.data):
 *   - output:  most recent node_completed / node_completed_with_warning
 *              event's `node_output` (string).
 *   - error:   most recent node_failed event's `error` (string).
 *   - prompt:  most recent node_started event carrying `prompt` (string).
 *              The events table does not always persist the prompt — the
 *              NodePeekPanel still falls back to the YAML node definition.
 *   - diff:    most recent event carrying a `diff` data field (string). Not
 *              all node types produce a diff; this is empty for most.
 *
 * Pure: no React, no I/O.
 */

import type { WorkflowEventResponse } from './api';

export interface PeekData {
  output?: string;
  diff?: string;
  error?: string;
  prompt?: string;
}

function firstStringField(
  events: readonly WorkflowEventResponse[],
  predicate: (ev: WorkflowEventResponse) => boolean,
  field: string
): string | undefined {
  for (const ev of events) {
    if (!predicate(ev)) continue;
    const value = ev.data[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function selectPeekData(events: readonly WorkflowEventResponse[]): PeekData {
  const output = firstStringField(
    events,
    ev => ev.event_type === 'node_completed' || ev.event_type === 'node_completed_with_warning',
    'node_output'
  );
  const error = firstStringField(events, ev => ev.event_type === 'node_failed', 'error');
  const prompt = firstStringField(events, ev => ev.event_type === 'node_started', 'prompt');
  // `diff` may attach to any of completed / artifact / custom events; scan all.
  const diff = firstStringField(events, () => true, 'diff');

  const result: PeekData = {};
  if (output !== undefined) result.output = output;
  if (error !== undefined) result.error = error;
  if (prompt !== undefined) result.prompt = prompt;
  if (diff !== undefined) result.diff = diff;
  return result;
}
