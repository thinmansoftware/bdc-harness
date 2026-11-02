import { describe, test, expect } from 'bun:test';
import { parseWorkflowRunBranchOverride } from './workflow-run-branch-override';

const BASE = '/workflow run bdc-feature-development WO_ID=WO-X --project lspro-react';

describe('parseWorkflowRunBranchOverride', () => {
  test('no flag -> kind none (default isolation preserved)', async () => {
    const r = await parseWorkflowRunBranchOverride(BASE);
    expect(r.kind).toBe('none');
  });

  test('valid --from origin/release/ce -> task hints', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from origin/release/ce`);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.hints.workflowType).toBe('task');
    expect(r.hints.fromBranch).toBe('origin/release/ce');
  });

  test('alias --from-branch behaves identically to --from', async () => {
    const a = await parseWorkflowRunBranchOverride(`${BASE} --from origin/release/ce`);
    const b = await parseWorkflowRunBranchOverride(`${BASE} --from-branch origin/release/ce`);
    expect(a).toEqual(b);
    if (b.kind !== 'ok') throw new Error('expected ok');
    expect(b.hints.fromBranch).toBe('origin/release/ce');
  });

  test('inline = form is accepted', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from=origin/release/ce`);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.hints.fromBranch).toBe('origin/release/ce');
  });

  test('missing value -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from`);
    expect(r.kind).toBe('error');
  });

  test('value swallowed by another flag -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from --project x`);
    expect(r.kind).toBe('error');
  });

  test('option-like value (leading dash) -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from=-origin/release/ce`);
    expect(r.kind).toBe('error');
  });

  test('duplicate --from flags -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(
      `${BASE} --from origin/release/ce --from origin/main`
    );
    expect(r.kind).toBe('error');
  });

  test('mixed aliases (--from + --from-branch) -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(
      `${BASE} --from origin/release/ce --from-branch origin/main`
    );
    expect(r.kind).toBe('error');
  });

  test('non-origin value (bare release/ce) -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from release/ce`);
    expect(r.kind).toBe('error');
  });

  test('origin/ with empty branch portion -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from origin/`);
    expect(r.kind).toBe('error');
  });

  test('invalid branch per git check-ref-format (dot-dot) -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from origin/foo..bar`);
    expect(r.kind).toBe('error');
  });

  test('invalid branch per git check-ref-format (trailing .lock) -> error', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from origin/foo.lock`);
    expect(r.kind).toBe('error');
  });

  test('multi-segment origin branch is valid', async () => {
    const r = await parseWorkflowRunBranchOverride(`${BASE} --from origin/feature/nested/name`);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.hints.fromBranch).toBe('origin/feature/nested/name');
  });
});
