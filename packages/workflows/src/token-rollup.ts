import type { IWorkflowStore, WorkflowEventRecord } from './store';
import { createLogger } from '@archon/paths';

export interface ModelTokenTotals {
  input_tokens: number;
  output_tokens: number;
}

export interface RunTokenTotals extends Record<string, unknown> {
  by_model: Record<string, ModelTokenTotals>;
  total_input_tokens: number;
  total_output_tokens: number;
  incomplete?: true;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.token-rollup');
  return cachedLog;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function addTotals(totals: RunTokenTotals, model: string, input: number, output: number): void {
  const existing = totals.by_model[model] ?? { input_tokens: 0, output_tokens: 0 };
  existing.input_tokens += input;
  existing.output_tokens += output;
  totals.by_model[model] = existing;
  totals.total_input_tokens += input;
  totals.total_output_tokens += output;
}

function normalizeUsageMapEntry(value: unknown): ModelTokenTotals | undefined {
  const usage = objectField(value);
  if (!usage) return undefined;
  const input = numberField(usage.input_tokens) ?? numberField(usage.input);
  const output = numberField(usage.output_tokens) ?? numberField(usage.output);
  if (input === undefined && output === undefined) return undefined;
  return { input_tokens: input ?? 0, output_tokens: output ?? 0 };
}

function fallbackModelId(data: Record<string, unknown>): string {
  return (
    stringField(data.requested_model_id) ??
    stringField(data.declared_model_id) ??
    stringField(data.served_model_id) ??
    'unknown'
  );
}

function isUsageEligibleNodeEvent(data: Record<string, unknown>): boolean {
  return (
    data.model_usage !== undefined ||
    data.tokens !== undefined ||
    data.requested_model_id !== undefined ||
    data.declared_model_id !== undefined ||
    data.served_model_id !== undefined ||
    data.entry_rung !== undefined ||
    data.stop_reason !== undefined ||
    data.num_turns !== undefined ||
    data.cost_usd !== undefined
  );
}

export function aggregateRunTokenTotals(events: WorkflowEventRecord[]): RunTokenTotals {
  const totals: RunTokenTotals = {
    by_model: {},
    total_input_tokens: 0,
    total_output_tokens: 0,
  };

  for (const event of events) {
    if (event.event_type !== 'node_completed' && event.event_type !== 'node_failed') continue;

    const data = objectField(event.data) ?? {};
    const modelUsage = objectField(data.model_usage);
    if (modelUsage) {
      let addedAnyModel = false;
      for (const [model, rawUsage] of Object.entries(modelUsage)) {
        const usage = normalizeUsageMapEntry(rawUsage);
        if (!usage) continue;
        addTotals(totals, model, usage.input_tokens, usage.output_tokens);
        addedAnyModel = true;
      }
      if (!addedAnyModel && isUsageEligibleNodeEvent(data)) totals.incomplete = true;
      continue;
    }

    const tokens = objectField(data.tokens);
    if (tokens) {
      const input = numberField(tokens.input) ?? numberField(tokens.input_tokens);
      const output = numberField(tokens.output) ?? numberField(tokens.output_tokens);
      if (input !== undefined || output !== undefined) {
        addTotals(totals, fallbackModelId(data), input ?? 0, output ?? 0);
        continue;
      }
    }

    if (isUsageEligibleNodeEvent(data)) totals.incomplete = true;
  }

  if (totals.incomplete !== true && Object.keys(totals.by_model).length === 0) {
    totals.incomplete = true;
  }

  return totals;
}

export async function emitRunTokenTotals(
  store: IWorkflowStore,
  workflowRunId: string
): Promise<void> {
  try {
    const events = await store.listWorkflowEvents(workflowRunId);
    if (events.some(event => event.event_type === 'run_token_totals')) return;
    await store.createWorkflowEvent({
      workflow_run_id: workflowRunId,
      event_type: 'run_token_totals',
      data: aggregateRunTokenTotals(events),
    });
  } catch (err) {
    getLog().warn({ err: err as Error, workflowRunId }, 'workflow_run_token_totals_emit_failed');
  }
}
