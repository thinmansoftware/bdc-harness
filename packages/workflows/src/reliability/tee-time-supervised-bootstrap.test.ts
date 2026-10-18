import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireSupervisedController, claimSupervisedPhase } from './tee-time-supervised-bootstrap';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teetime-supervised-test-'));
  roots.push(root);
  return root;
}
const binding = 'sha256:' + '1'.repeat(64);
const reviewed = {
  bindingHash: binding,
  reviewId: 123,
  reviewHead: 'a'.repeat(40),
  reviewer: 'independent-reviewer',
  state: 'APPROVED' as const,
};

test('exclusive controller ownership persists until verified normal completion', async () => {
  const root = await fixture();
  const owner = await acquireSupervisedController(root, binding);
  await expect(acquireSupervisedController(root, binding)).rejects.toThrow();
  expect(JSON.parse(await readFile(join(root, 'controller.lock'), 'ascii')).bindingHash).toBe(
    binding
  );
  await owner.releaseAfterNormalCompletion();
  const next = await acquireSupervisedController(root, binding);
  await next.releaseAfterNormalCompletion();
});

test('claimed action stays consumed after normal release and reacquisition', async () => {
  const root = await fixture();
  const owner = await acquireSupervisedController(root, binding);
  await claimSupervisedPhase(owner, 'model', reviewed);
  await expect(claimSupervisedPhase(owner, 'model', reviewed)).rejects.toThrow();
  await owner.releaseAfterNormalCompletion();
  const next = await acquireSupervisedController(root, binding);
  await expect(claimSupervisedPhase(next, 'model', reviewed)).rejects.toThrow();
  await next.releaseAfterNormalCompletion();
  expect((await readdir(root)).includes('model.claim.json')).toBe(true);
});

test('wrong binding or foreign/replaced lock cannot authorize side effects', async () => {
  const root = await fixture();
  const owner = await acquireSupervisedController(root, binding);
  await expect(
    claimSupervisedPhase(owner, 'model', { ...reviewed, bindingHash: 'sha256:' + '2'.repeat(64) })
  ).rejects.toThrow();
  await writeFile(join(root, 'controller.lock'), '{}\n');
  await expect(claimSupervisedPhase(owner, 'publish', reviewed)).rejects.toThrow();
  await expect(owner.releaseAfterNormalCompletion()).rejects.toThrow();
  expect(await readdir(root)).toEqual(['controller.lock']);
});

test('invalid review fails before an exclusive claim is created', async () => {
  const root = await fixture();
  const owner = await acquireSupervisedController(root, binding);
  for (const changed of [
    { state: 'COMMENTED' },
    { reviewId: 0 },
    { reviewHead: 'HEAD' },
    { reviewer: '' },
    { phase: 'publish' },
    { version: 9 },
    { unexpected: true },
  ]) {
    await expect(
      claimSupervisedPhase(owner, 'model', { ...reviewed, ...changed } as typeof reviewed)
    ).rejects.toThrow();
  }
  expect(await readdir(root)).toEqual(['controller.lock']);
  await owner.releaseAfterNormalCompletion();
});

test('concurrent claim and release cannot remove active controller ownership', async () => {
  const root = await fixture();
  const owner = await acquireSupervisedController(root, binding);
  const claim = claimSupervisedPhase(owner, 'model', reviewed);
  await expect(owner.releaseAfterNormalCompletion()).rejects.toThrow();
  await claim;
  const release = owner.releaseAfterNormalCompletion();
  await expect(owner.releaseAfterNormalCompletion()).rejects.toThrow();
  await release;
});

test('terminated owned process leaves a blocking lock and consumed claim', async () => {
  const root = await fixture();
  const module = pathToFileURL(join(import.meta.dir, 'tee-time-supervised-bootstrap.ts')).href;
  const code = `const api=await import(${JSON.stringify(module)});
    const owner=await api.acquireSupervisedController(${JSON.stringify(root)},${JSON.stringify(binding)});
    await api.claimSupervisedPhase(owner,'model',${JSON.stringify(reviewed)});
    process.stdout.write('OWNED-CLAIM-FLUSHED\\n');setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, '--eval', code], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH },
  });
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toBe('OWNED-CLAIM-FLUSHED\n');
    child.kill();
    await child.exited;
    await expect(acquireSupervisedController(root, binding)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, 'model.claim.json'), 'ascii')).bindingHash).toBe(
      binding
    );
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
  }
});

test('existing roots and phase path directories are never overwritten', async () => {
  const root = await fixture();
  await mkdir(join(root, 'model.claim.json'));
  const owner = await acquireSupervisedController(root, binding);
  await expect(claimSupervisedPhase(owner, 'model', reviewed)).rejects.toThrow();
  await owner.releaseAfterNormalCompletion();
});
