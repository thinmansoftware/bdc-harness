import { readFile } from 'node:fs/promises';
import {
  assertNoLooseTargetOverrides,
  verifyM42Slice8BManifest,
  type M42Slice8BManifestEnvelope,
  type M42Slice8BManifestPayload,
  type M42Slice8BPrimaryAction,
} from './m42-slice8b-manifest';
import { enforceM42Slice8BGate1 } from './m42-slice8b-gate1';

export type M42Slice8BRunnerActionName = M42Slice8BPrimaryAction | 'REOPEN_ROLLBACK';
export type M42Slice8BRunnerStopReason =
  | 'completed'
  | 'manifest_refused'
  | 'cli_override_refused'
  | 'gate1_refused'
  | 'execution_duplicate'
  | 'window_exceeded'
  | 'action_indeterminate'
  | 'action_refused'
  | 'rollback_failed';

export interface M42Slice8BActionReceipt {
  readonly action: M42Slice8BRunnerActionName;
  readonly execution_id: string;
  readonly accepted: boolean;
  readonly indeterminate: boolean;
  readonly m31_receipt_recorded: boolean;
  readonly provider_receipt_recorded: boolean;
  readonly fusion_budget_receipt_recorded: boolean;
  readonly rollback_receipt_recorded: boolean;
  readonly provider_call_count: number;
  readonly fusion_call_count: number;
  readonly production_mutation_count: number;
  readonly receipt_id: string;
  readonly rollback_state_digest?: string;
}

export interface M42Slice8BRunnerReceipt {
  readonly schema_version: 'm42-slice8b-canary-runner-receipt-v1';
  readonly ok: boolean;
  readonly stop_reason: M42Slice8BRunnerStopReason;
  readonly execution_id: string | null;
  readonly attempted_primary_actions: readonly M42Slice8BPrimaryAction[];
  readonly rollback_actions: readonly Extract<M42Slice8BRunnerActionName, 'REOPEN_ROLLBACK'>[];
  readonly unexpected_action_count: number;
  readonly provider_call_count: number;
  readonly fusion_call_count: number;
  readonly production_mutation_count: number;
  readonly m31_receipt_count: number;
  readonly provider_receipt_count: number;
  readonly fusion_budget_receipt_count: number;
  readonly rollback_receipt_count: number;
  readonly circuit_breaker_opened: boolean;
  readonly rollback_verified: boolean;
  readonly receipts: readonly M42Slice8BActionReceipt[];
  readonly xo_briefing_reconciled: boolean;
}

export interface M42Slice8BExecutionStore {
  begin(executionId: string, manifestDigest: string): Promise<'fresh' | 'duplicate' | 'conflict'>;
  commit(executionId: string, receipt: M42Slice8BRunnerReceipt): Promise<void>;
}

export interface M42Slice8BActionExecutor {
  execute(input: {
    readonly action: M42Slice8BRunnerActionName;
    readonly manifest: M42Slice8BManifestPayload;
  }): Promise<M42Slice8BActionReceipt>;
}

export interface M42Slice8BRunnerDeps {
  readonly expected_candidate_sha: string;
  readonly expected_starting_sha: string;
  readonly expected_repository_full_name: string;
  readonly expected_provider_repository_id: string;
  readonly nowMs: () => number;
  readonly executionStore: M42Slice8BExecutionStore;
  readonly actions: M42Slice8BActionExecutor;
}

export class InMemoryM42Slice8BExecutionStore implements M42Slice8BExecutionStore {
  private readonly started = new Map<string, string>();

  async begin(
    executionId: string,
    manifestDigest: string
  ): Promise<'fresh' | 'duplicate' | 'conflict'> {
    const existing = this.started.get(executionId);
    if (existing === undefined) {
      this.started.set(executionId, manifestDigest);
      return 'fresh';
    }
    return existing === manifestDigest ? 'duplicate' : 'conflict';
  }

  async commit(_executionId: string, _receipt: M42Slice8BRunnerReceipt): Promise<void> {
    return undefined;
  }
}

export function createFakeM42Slice8BActionExecutor(
  overrides: Partial<Record<M42Slice8BRunnerActionName, Partial<M42Slice8BActionReceipt>>> = {}
): M42Slice8BActionExecutor {
  return {
    async execute({ action, manifest }) {
      const executionId = `${manifest.execution_id}:${action}`;
      const base: M42Slice8BActionReceipt = {
        action,
        execution_id: executionId,
        accepted: true,
        indeterminate: false,
        m31_receipt_recorded: true,
        provider_receipt_recorded: true,
        fusion_budget_receipt_recorded: true,
        rollback_receipt_recorded: action === 'REOPEN_ROLLBACK',
        provider_call_count: 0,
        fusion_call_count: 0,
        production_mutation_count: 0,
        receipt_id: `fake-${executionId}`,
        rollback_state_digest:
          action === 'REOPEN_ROLLBACK' ? manifest.declared_rollback_state_digest : undefined,
      };
      return { ...base, ...overrides[action] };
    },
  };
}

export async function runM42Slice8BCanary(
  envelope: M42Slice8BManifestEnvelope,
  deps: M42Slice8BRunnerDeps
): Promise<M42Slice8BRunnerReceipt> {
  const verified = verifyM42Slice8BManifest(envelope, {
    candidate_sha: deps.expected_candidate_sha,
    starting_sha: deps.expected_starting_sha,
    repository_full_name: deps.expected_repository_full_name,
    provider_repository_id: deps.expected_provider_repository_id,
  });
  if (!verified.ok) return stopped(null, 'manifest_refused', [], [], [], false);

  const gate1 = enforceM42Slice8BGate1(verified.manifest);
  if (!gate1.ok) return stopped(verified.manifest.execution_id, 'gate1_refused', [], [], [], false);

  const begin = await deps.executionStore.begin(verified.manifest.execution_id, verified.digest);
  if (begin !== 'fresh') {
    return stopped(verified.manifest.execution_id, 'execution_duplicate', [], [], [], false);
  }

  const startedAt = deps.nowMs();
  const receipts: M42Slice8BActionReceipt[] = [];
  const attempted: M42Slice8BPrimaryAction[] = [];
  const rollbackActions: Extract<M42Slice8BRunnerActionName, 'REOPEN_ROLLBACK'>[] = [];
  let circuitBreakerOpened = false;

  for (const action of verified.manifest.expected_primary_actions) {
    if (deps.nowMs() - startedAt > 60 * 60 * 1000) {
      const receipt = stopped(
        verified.manifest.execution_id,
        'window_exceeded',
        attempted,
        rollbackActions,
        receipts,
        circuitBreakerOpened
      );
      await deps.executionStore.commit(verified.manifest.execution_id, receipt);
      return receipt;
    }

    const receipt = await deps.actions.execute({ action, manifest: verified.manifest });
    receipts.push(receipt);
    attempted.push(action);
    if (receipt.indeterminate) {
      circuitBreakerOpened = true;
      const stoppedReceipt = stopped(
        verified.manifest.execution_id,
        'action_indeterminate',
        attempted,
        rollbackActions,
        receipts,
        circuitBreakerOpened
      );
      await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
      return stoppedReceipt;
    }
    if (!receipt.accepted) {
      const stoppedReceipt = stopped(
        verified.manifest.execution_id,
        'action_refused',
        attempted,
        rollbackActions,
        receipts,
        circuitBreakerOpened
      );
      await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
      return stoppedReceipt;
    }

    if (action === 'CLOSE') {
      const rollback = await deps.actions.execute({
        action: 'REOPEN_ROLLBACK',
        manifest: verified.manifest,
      });
      receipts.push(rollback);
      rollbackActions.push('REOPEN_ROLLBACK');
      if (
        !rollback.accepted ||
        rollback.indeterminate ||
        rollback.rollback_state_digest !== verified.manifest.declared_rollback_state_digest
      ) {
        const stoppedReceipt = stopped(
          verified.manifest.execution_id,
          'rollback_failed',
          attempted,
          rollbackActions,
          receipts,
          true
        );
        await deps.executionStore.commit(verified.manifest.execution_id, stoppedReceipt);
        return stoppedReceipt;
      }
    }
  }

  const completed = stopped(
    verified.manifest.execution_id,
    'completed',
    attempted,
    rollbackActions,
    receipts,
    circuitBreakerOpened
  );
  await deps.executionStore.commit(verified.manifest.execution_id, completed);
  return completed;
}

function stopped(
  executionId: string | null,
  stopReason: M42Slice8BRunnerStopReason,
  attemptedPrimaryActions: readonly M42Slice8BPrimaryAction[],
  rollbackActions: readonly Extract<M42Slice8BRunnerActionName, 'REOPEN_ROLLBACK'>[],
  receipts: readonly M42Slice8BActionReceipt[],
  circuitBreakerOpened: boolean
): M42Slice8BRunnerReceipt {
  const providerCalls = receipts.reduce((count, receipt) => count + receipt.provider_call_count, 0);
  const fusionCalls = receipts.reduce((count, receipt) => count + receipt.fusion_call_count, 0);
  const productionMutations = receipts.reduce(
    (count, receipt) => count + receipt.production_mutation_count,
    0
  );
  const m31ReceiptCount = receipts.filter(receipt => receipt.m31_receipt_recorded).length;
  const providerReceiptCount = receipts.filter(receipt => receipt.provider_receipt_recorded).length;
  const fusionBudgetReceiptCount = receipts.filter(
    receipt => receipt.fusion_budget_receipt_recorded
  ).length;
  const rollbackReceiptCount = receipts.filter(receipt => receipt.rollback_receipt_recorded).length;
  const rollbackVerified =
    stopReason === 'completed' &&
    rollbackActions.length === 1 &&
    receipts.some(r => r.action === 'REOPEN_ROLLBACK');
  return {
    schema_version: 'm42-slice8b-canary-runner-receipt-v1',
    ok: stopReason === 'completed',
    stop_reason: stopReason,
    execution_id: executionId,
    attempted_primary_actions: attemptedPrimaryActions,
    rollback_actions: rollbackActions,
    unexpected_action_count: 0,
    provider_call_count: providerCalls,
    fusion_call_count: fusionCalls,
    production_mutation_count: productionMutations,
    m31_receipt_count: m31ReceiptCount,
    provider_receipt_count: providerReceiptCount,
    fusion_budget_receipt_count: fusionBudgetReceiptCount,
    rollback_receipt_count: rollbackReceiptCount,
    circuit_breaker_opened: circuitBreakerOpened,
    rollback_verified: rollbackVerified,
    receipts,
    xo_briefing_reconciled:
      stopReason === 'completed' &&
      attemptedPrimaryActions.length === 4 &&
      providerCalls === 0 &&
      productionMutations === 0,
  };
}

async function main(): Promise<number> {
  try {
    const argv = process.argv.slice(2);
    assertNoLooseTargetOverrides(argv);
    const manifestArg = argv.find(arg => arg.startsWith('--manifest='));
    const manifestPath =
      manifestArg?.slice('--manifest='.length) ?? argv[argv.indexOf('--manifest') + 1];
    if (!manifestPath) throw new Error('manifest_required');
    const envelope = JSON.parse(await readFile(manifestPath, 'utf8')) as M42Slice8BManifestEnvelope;
    const receipt = await runM42Slice8BCanary(envelope, {
      expected_candidate_sha: envelope.payload.candidate_sha,
      expected_starting_sha: envelope.payload.starting_sha,
      expected_repository_full_name: envelope.payload.repository_full_name,
      expected_provider_repository_id: envelope.payload.provider_repository_id,
      nowMs: () => Date.now(),
      executionStore: new InMemoryM42Slice8BExecutionStore(),
      actions: createFakeM42Slice8BActionExecutor(),
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
