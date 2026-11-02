/**
 * Check if a workflow status represents a terminal (finished) state.
 * escalated is terminal (WO-HARNESS-ESCALATED-RUN-STATUS-01) and distinct from failed.
 */
export function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'escalated' ||
    status === 'cancelled'
  );
}
