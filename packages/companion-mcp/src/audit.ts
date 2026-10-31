import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { ARG_MAX_CHARS } from './constants';
import { scrub } from './scrub';
import type { ToolOutcome } from './errors';

export interface AuditEvent {
  companionId: string;
  tool: string;
  args: Record<string, unknown>;
  rowCount: number;
  outcome: ToolOutcome;
  error?: string;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const redacted = scrub(value);
    return redacted.length > ARG_MAX_CHARS ? redacted.slice(0, ARG_MAX_CHARS) : redacted;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubValue(item));
  }
  if (typeof value === 'object' && value !== undefined) {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      next[key] = scrubValue(item);
    }
    return next;
  }
  return null;
}

export function scrubArgs(args: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubValue(args);
  if (typeof scrubbed === 'object' && scrubbed !== null && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}

export function appendAudit(logPath: string, event: AuditEvent): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    companion_id: event.companionId,
    tool: event.tool,
    args: scrubArgs(event.args),
    row_count: event.rowCount,
    outcome: event.outcome,
  };
  if (event.error !== undefined) {
    line.error = event.error;
  }
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(line)}\n`, 'utf8');
}
