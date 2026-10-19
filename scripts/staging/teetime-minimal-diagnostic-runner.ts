import type { MessageChunk } from '../../packages/providers/src/types';
import { collectMinimalDiagnostic, type MinimalDiagnosticResult } from './teetime-minimal-diagnostic';

export interface DiagnosticClock {
  arm(callback: () => void, milliseconds: number): () => void;
}
const runtimeClock: DiagnosticClock = {
  arm(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

// Unregistered runner. Clock injection is an offline test seam, not a CLI option.
// The future worker must enforce an independent process deadline and reaping.
export async function runMinimalDiagnostic(
  query: (prompt: string, signal: AbortSignal) => AsyncIterable<MessageChunk>,
  clock: DiagnosticClock = runtimeClock
): Promise<Readonly<MinimalDiagnosticResult>> {
  const controller = new AbortController();
  let closed = false, cleared = false;
  const cancel = clock.arm(() => { if (!closed) controller.abort(); }, 90000);
  function clearDeadline(): void {
    if (!cleared) { cleared = true; cancel(); }
  }
  try {
    return await collectMinimalDiagnostic(query, controller, () => {
      closed = true;
      clearDeadline();
    });
  } finally {
    clearDeadline();
  }
}
