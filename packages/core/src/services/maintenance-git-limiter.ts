import { readFile } from 'fs/promises';
import { createLogger } from '@archon/paths';

export type MaintenanceGitExecutor = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

export class MaintenanceGitUnavailableError extends Error {
  constructor() {
    super('maintenance git unavailable for this cleanup run');
    this.name = 'MaintenanceGitUnavailableError';
  }
}

export interface MaintenanceGitContext {
  readonly concurrency: number;
  readonly inFlight: number;
  readonly maxInFlight: number;
  readonly tripped: boolean;
  readonly resourceExhaustionCount: number;
  execute: MaintenanceGitExecutor;
}

export function isGitResourceExhaustion(error: unknown): boolean {
  const value = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const text = [value?.code, value?.errno, value?.message, value?.stdout, value?.stderr]
    .map(String)
    .join(' ')
    .toLowerCase();
  return (
    text.includes('eagain') ||
    text.includes('resource temporarily unavailable') ||
    /unable to create[^\n]*thread/.test(text)
  );
}

async function threadCount(): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const match = /^Threads:\s+(\d+)$/m.exec(await readFile('/proc/self/status', 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export function createMaintenanceGitContext(
  limitValue = process.env.MAINTENANCE_GIT_CONCURRENCY
): MaintenanceGitContext {
  const parsed = Number.parseInt(limitValue ?? '4', 10);
  const concurrency = Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
  let active = 0;
  let maximum = 0;
  let exhausted = 0;
  let stopped = false;
  const waiters: (() => void)[] = [];
  const log = createLogger('maintenance-git');
  const acquire = async (): Promise<void> => {
    if (active >= concurrency) await new Promise<void>(resolve => waiters.push(resolve));
    active++;
    maximum = Math.max(maximum, active);
  };
  const context: MaintenanceGitContext = {
    concurrency,
    get inFlight() {
      return active;
    },
    get maxInFlight() {
      return maximum;
    },
    get tripped() {
      return stopped;
    },
    get resourceExhaustionCount() {
      return exhausted;
    },
    async execute<T>(path: string, operation: () => Promise<T>): Promise<T> {
      if (stopped) throw new MaintenanceGitUnavailableError();
      await acquire();
      try {
        if (stopped) throw new MaintenanceGitUnavailableError();
        return await operation();
      } catch (error) {
        if (isGitResourceExhaustion(error)) {
          exhausted++;
          if (!stopped) {
            stopped = true;
            log.error(
              {
                count: 1,
                firstPath: path,
                threadCount: await threadCount(),
                inFlightGitCount: active,
              },
              'maintenance_git_resource_exhausted'
            );
          }
          throw new MaintenanceGitUnavailableError();
        }
        throw error;
      } finally {
        active--;
        waiters.shift()?.();
      }
    },
  };
  return context;
}
