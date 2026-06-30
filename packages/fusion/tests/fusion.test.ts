import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { runFusion, redactSecrets } from '../src';
import {
  baseDiff,
  baseWorkOrder,
  fixtureReviewers,
  mismatchStub,
  missingReviewerStub,
  successfulStub,
} from '../src/fixtures/scenarios';

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fusion-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('fusion package', () => {
  test('full run writes round-1 artifacts, synthesis, and manifest v2', async () => {
    const root = await tempRoot();
    const result = await runFusion({
      slug: 'full-run',
      diff: baseDiff,
      workOrder: baseWorkOrder,
      outputRoot: root,
      reviewers: fixtureReviewers,
      callModel: successfulStub,
    });

    expect(result.manifest.schema_version).toBe(2);
    expect(result.manifest.validation.status).toBe('PASS');
    expect(result.manifest.status).toBe('PASS');
    expect(result.manifest.reviewers).toHaveLength(4);

    const synthesis = await readFile(result.synthesisPath, 'utf8');
    for (const section of [
      'Final Ruling',
      'Consensus Findings',
      'Disagreements',
      'Highest Risk',
      'Must Fix',
      'Nice To Have',
      'Scope Creep',
      'Doctrine Boundary',
      'Security/PII',
      'QA/Evidence',
      'Builder Prompt',
      'John Approval Question',
    ]) {
      expect(synthesis).toContain(`## ${section}`);
    }

    for (const reviewer of fixtureReviewers) {
      expect(await readFile(join(result.runDir, 'round-1', `${reviewer.role}.prompt.md`), 'utf8')).toContain(
        baseWorkOrder
      );
      expect(await readFile(join(result.runDir, 'round-1', `${reviewer.role}.md`), 'utf8')).toContain(
        reviewer.role
      );
    }
  });

  test('missing reviewer is represented as MISSING and blocks validation', async () => {
    const root = await tempRoot();
    const result = await runFusion({
      slug: 'missing-reviewer',
      diff: baseDiff,
      workOrder: baseWorkOrder,
      outputRoot: root,
      reviewers: fixtureReviewers,
      callModel: missingReviewerStub,
    });

    const qa = result.manifest.reviewers.find((reviewer) => reviewer.role === 'qa-evidence');
    expect(qa?.status).toBe('MISSING');
    expect(result.manifest.validation.status).toBe('FAIL');
    expect(result.manifest.status).toBe('NEEDS_REVISION');
  });

  test('redacts sk tokens and JWTs before writing prompts or diff artifacts', async () => {
    const secretDiff = `${baseDiff}\n+const a = "sk-1234567890abcdefghijklmnop";\n+const b = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";`;
    expect(redactSecrets(secretDiff)).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(redactSecrets(secretDiff)).not.toContain('eyJhbGciOiJIUzI1NiJ9');

    const root = await tempRoot();
    const result = await runFusion({
      slug: 'secret-redaction',
      diff: secretDiff,
      workOrder: baseWorkOrder,
      outputRoot: root,
      reviewers: fixtureReviewers.slice(0, 1),
      callModel: successfulStub,
    });

    expect(await readFile(join(result.runDir, 'diff.patch'), 'utf8')).toContain('[REDACTED_SECRET]');
    expect(await readFile(join(result.runDir, 'round-1', 'correctness.prompt.md'), 'utf8')).not.toContain(
      'sk-1234567890abcdefghijklmnop'
    );
  });

  test('gateway seam can be swapped and served model mismatches fail integrity validation', async () => {
    const root = await tempRoot();
    const result = await runFusion({
      slug: 'stubbed-gateway',
      diff: baseDiff,
      workOrder: baseWorkOrder,
      outputRoot: root,
      reviewers: fixtureReviewers,
      callModel: mismatchStub,
    });

    const correctness = result.manifest.reviewers.find((reviewer) => reviewer.role === 'correctness');
    expect(correctness?.served_model_id).toBe('fixture/wrong-model');
    expect(correctness?.served_model_mismatch).toBe(true);
    expect(correctness?.ok).toBe(false);
    expect(result.manifest.validation.status).toBe('FAIL');
  });
});
