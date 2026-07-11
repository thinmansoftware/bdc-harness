import { classifyError } from './classify';
import { OverseerService, type OverseerActionStore } from './service';

export interface WatchFailureInput {
  runId: string;
  message: string;
  attempt: number;
  hasCommittedDiff?: boolean;
  hasUnstagedDiff?: boolean;
  store?: OverseerActionStore;
}

export async function watchFailure(input: WatchFailureInput) {
  const failureClass = classifyError({ message: input.message });
  const service = new OverseerService({ enabled: true, store: input.store });
  return service.reconcile({
    runId: input.runId,
    failureClass,
    attempt: input.attempt,
    hasCommittedDiff: input.hasCommittedDiff ?? false,
    hasUnstagedDiff: input.hasUnstagedDiff ?? false,
  });
}
