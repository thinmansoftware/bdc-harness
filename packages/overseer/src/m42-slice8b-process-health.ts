export type M42Slice8BRuntimeHonestyVerdict = 'RUNTIME_HEALTHY' | 'BUILD_READY_NOT_RUNTIME_READY';

export interface M42Slice8BObservedProcess {
  readonly pid: number;
  readonly started_at_ms: number;
  readonly healthy: boolean;
  readonly command: string;
}

export interface M42Slice8BProcessSnapshot {
  readonly observed_at_ms: number;
  readonly processes: readonly M42Slice8BObservedProcess[];
}

export interface M42Slice8BProcessHealthReceipt {
  readonly schema_version: 'm42-slice8b-process-health-v1';
  readonly verdict: M42Slice8BRuntimeHonestyVerdict;
  readonly healthy_process_count: number;
  readonly audited_host: string;
  readonly restart_detected: boolean;
  readonly recovered: boolean;
  readonly no_double_action: boolean;
}

export function assessM42Slice8BProcessHealth(input: {
  readonly audited_host: string;
  readonly before: M42Slice8BProcessSnapshot;
  readonly after?: M42Slice8BProcessSnapshot;
  readonly action_execution_ids: readonly string[];
}): M42Slice8BProcessHealthReceipt {
  const healthyBefore = input.before.processes.filter(process => process.healthy);
  const healthyAfter = input.after?.processes.filter(process => process.healthy) ?? [];
  const restartDetected =
    input.after !== undefined &&
    healthyBefore.length > 0 &&
    healthyAfter.length > 0 &&
    healthyBefore[0]?.pid !== healthyAfter[0]?.pid;
  const noDoubleAction =
    new Set(input.action_execution_ids).size === input.action_execution_ids.length;
  const recovered = restartDetected
    ? healthyAfter.length > 0 && noDoubleAction
    : healthyBefore.length > 0;

  return {
    schema_version: 'm42-slice8b-process-health-v1',
    verdict: healthyBefore.length > 0 ? 'RUNTIME_HEALTHY' : 'BUILD_READY_NOT_RUNTIME_READY',
    healthy_process_count: healthyBefore.length,
    audited_host: input.audited_host,
    restart_detected: restartDetected,
    recovered,
    no_double_action: noDoubleAction,
  };
}
