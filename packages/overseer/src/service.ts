import type { OverseerAction } from './actions/types';
import { reconcileRun, type ReconcileInput } from './reconcile';

export interface OverseerActionStore {
  append(action: OverseerAction): Promise<OverseerAction>;
  list(runId: string): Promise<OverseerAction[]>;
}

export class MemoryOverseerActionStore implements OverseerActionStore {
  private readonly actions: OverseerAction[] = [];

  async append(action: OverseerAction): Promise<OverseerAction> {
    this.actions.push(action);
    return action;
  }

  async list(runId: string): Promise<OverseerAction[]> {
    return this.actions.filter(action => action.runId === runId);
  }
}

export interface OverseerServiceOptions {
  enabled?: boolean;
  store?: OverseerActionStore;
}

export class OverseerService {
  private readonly enabled: boolean;
  private readonly store: OverseerActionStore;

  constructor(options: OverseerServiceOptions = {}) {
    this.enabled = options.enabled ?? process.env.OVERSEER_ENABLED === 'true';
    this.store = options.store ?? new MemoryOverseerActionStore();
  }

  async reconcile(input: ReconcileInput): Promise<OverseerAction | undefined> {
    if (!this.enabled) return undefined;
    const action = reconcileRun(input);
    return this.store.append(action);
  }

  async actions(runId: string): Promise<OverseerAction[]> {
    return this.store.list(runId);
  }
}
