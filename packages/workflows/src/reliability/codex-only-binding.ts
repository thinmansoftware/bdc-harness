import { createHash } from 'node:crypto';
export interface CodexOnlyBinding {
  project: string;
  codebaseId: string;
  cwd: string;
  workflowDigest: string;
}

export function workflowDigest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)])
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Compare the registration and definition actually loaded by the dispatch handler. */
export function matchesCodexOnlyBinding(
  binding: CodexOnlyBinding,
  actual: { codebaseId?: string | null; cwd?: string; workflow: unknown }
): boolean {
  return (
    actual.codebaseId === binding.codebaseId &&
    actual.cwd === binding.cwd &&
    workflowDigest(actual.workflow) === binding.workflowDigest
  );
}
