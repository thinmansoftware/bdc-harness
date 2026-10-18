import { describe, expect, it } from 'bun:test';
import { buildRunAuthority } from './run-authority';
import { policyDigest } from '@archon/paths/tee-time-policy';
import { evidenceHash } from '../../../providers/src/community/pi/restricted-review-evidence';
import {
  REVIEW_DIGEST,
  REVIEW_MODEL,
  REVIEW_SYSTEM,
} from '../../../providers/src/community/pi/restricted-review-policy';
import { buildRestrictedReviewWire } from '../../../providers/src/community/pi/restricted-review-wire';
import { assembleTeeTimeReviewPackage } from './tee-time-review-package';

function serialize(prompt: string): string {
  return JSON.stringify({
    model: REVIEW_MODEL,
    stream: true,
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content:
          REVIEW_SYSTEM + '\nCurrent date: 2026-10-18\nCurrent working directory: /workspace',
      },
      { role: 'user', content: prompt },
    ],
  });
}

function fixture(): Parameters<typeof assembleTeeTimeReviewPackage>[0] {
  const specBytes = new TextEncoder().encode('Synthetic foundation specification');
  const authority = buildRunAuthority({
    runId: 'run-1',
    dispatchId: 'dispatch-1',
    woId: 'WO-TEETIME-FOUNDATION-01',
    specSource: 'fixture',
    specRevision: '1',
    specBytes,
    workflowName: 'bdc-teetime-foundation',
    codebaseId: 'codebase-1',
    canonicalRemote: 'https://github.com/thinmansoftware/whats-that-tee-time.git',
    baseBranch: 'staging',
    baseSha: '1'.repeat(40),
    runScopeSha: 'a'.repeat(40),
    headBranch: 'fixture',
    worktreePath: '/fixture',
    workflowRevision: '2'.repeat(40),
    bundleRevision: '3'.repeat(40),
    engineRevision: '4'.repeat(40),
    runtimeImageRevision: null,
    createdAt: '2026-10-18T00:00:00Z',
  });
  const reviewedWorkflow = { name: 'bdc-teetime-foundation', fixture: true };
  const expectedPolicy = {
    hash: 'sha256:' + '5'.repeat(64),
    codebaseId: 'codebase-1',
    workflowDigest: policyDigest(reviewedWorkflow),
    woId: authority.woId,
  };
  const schemaHash = buildRestrictedReviewWire(serialize('fixture')).schemaHash;
  const binding = {
    runId: 'run-1',
    nodeId: 'review',
    attempt: 1,
    baseCommit: authority.baseSha,
    headCommit: '6'.repeat(40),
    sourceTree: '7'.repeat(40),
    authorityHash: policyDigest(authority),
    policyHash: expectedPolicy.hash,
    builderImage: 'sha256:' + '8'.repeat(64),
    testImage: 'sha256:' + '9'.repeat(64),
    reviewerImage: 'sha256:' + 'a'.repeat(64),
    reviewerSource: 'b'.repeat(40),
    reviewerModelDigest: REVIEW_DIGEST,
    reviewerSchemaHash: schemaHash,
    workerAttemptId: 'worker-1',
    snapshotManifestHash: 'c'.repeat(64),
  };
  const check = {
    id: 'behavior',
    commandHash: evidenceHash('bun test fixture.test.ts'),
    sourceTree: binding.sourceTree,
    image: binding.testImage,
    exitCode: 0,
    termination: 'completed' as const,
    truncated: false,
    skipped: 0,
    assertions: 4,
    output: 'Synthetic fixture: 4 assertions passed',
    outputHash: evidenceHash('Synthetic fixture: 4 assertions passed'),
  };
  return {
    authority,
    run: {
      id: 'run-1',
      codebase_id: 'codebase-1',
      metadata: { execution_policy: { ...expectedPolicy } },
    },
    reviewedWorkflow,
    expectedPolicy,
    specBytes,
    binding,
    git: {
      baseCommit: authority.baseSha,
      parentCommit: authority.baseSha,
      headCommit: binding.headCommit,
      sourceTree: binding.sourceTree,
      snapshotManifestHash: binding.snapshotManifestHash,
      builderImage: binding.builderImage,
      diffText: 'Synthetic complete text diff',
      complete: true,
      binary: false,
    },
    requiredChecks: [{ id: check.id, commandHash: check.commandHash }],
    checks: [check],
    serializeRequest: serialize,
  };
}

describe('pure tee-time implementation review package', () => {
  it('freezes exact payloads and reuses the existing final wire contract', () => {
    const input = fixture();
    const result = assembleTeeTimeReviewPackage(input);
    const pkg = JSON.parse(result.packageText);
    expect(pkg.artifacts.map((a: { id: string }) => a.id)).toEqual(['spec', 'diff', 'tests']);
    expect(pkg.artifacts[2].content).toBe(JSON.stringify(input.checks));
    expect(result.packageHash).toBe(evidenceHash(result.packageText));
    expect(JSON.parse(result.wireBody).messages[1].content).toBe(result.packageText);
    expect(result.wireBytes).toBeLessThanOrEqual(6000);
    input.binding.headCommit = 'd'.repeat(40);
    expect(result.binding.headCommit).toBe('6'.repeat(40));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect('verdict' in result).toBe(false);
  });
  it('rejects authority, run, policy, workflow and spec drift before serializer access', () => {
    const changes: ((i: ReturnType<typeof fixture>) => void)[] = [
      i => {
        i.run.id = 'other';
      },
      i => {
        i.run.codebase_id = 'other';
      },
      i => {
        i.authority.workflowName = 'other';
      },
      i => {
        i.authority.specHash = 'sha256:' + '0'.repeat(64);
      },
      i => {
        i.specBytes = new TextEncoder().encode('changed');
      },
      i => {
        i.run.metadata!.execution_policy = {};
      },
      i => {
        i.expectedPolicy.workflowDigest = 'sha256:' + '0'.repeat(64);
      },
      i => {
        i.expectedPolicy.woId = 'other';
      },
      i => {
        i.reviewedWorkflow = { name: 'changed' };
      },
    ];
    for (const change of changes) {
      const input = fixture();
      change(input);
      let called = false;
      input.serializeRequest = () => {
        called = true;
        return '';
      };
      expect(() => assembleTeeTimeReviewPackage(input)).toThrow();
      expect(called).toBe(false);
    }
  });
  it('rejects every changed binding and Git relation', () => {
    for (const key of [
      'runId',
      'authorityHash',
      'policyHash',
      'baseCommit',
      'headCommit',
      'sourceTree',
      'snapshotManifestHash',
      'builderImage',
      'reviewerModelDigest',
      'reviewerSchemaHash',
    ] as const) {
      const input = fixture();
      input.binding[key] = '0'.repeat(key.includes('Hash') ? 64 : 40);
      expect(() => assembleTeeTimeReviewPackage(input)).toThrow();
    }
    for (const key of [
      'baseCommit',
      'parentCommit',
      'headCommit',
      'sourceTree',
      'snapshotManifestHash',
      'builderImage',
    ] as const) {
      const input = fixture();
      input.git[key] = '0'.repeat(40);
      expect(() => assembleTeeTimeReviewPackage(input)).toThrow();
    }
    for (const change of [
      (i: ReturnType<typeof fixture>) => {
        i.git.complete = false;
      },
      (i: ReturnType<typeof fixture>) => {
        i.git.binary = true;
      },
      (i: ReturnType<typeof fixture>) => {
        i.git.diffText = '';
      },
    ]) {
      const input = fixture();
      change(input);
      expect(() => assembleTeeTimeReviewPackage(input)).toThrow();
    }
  });
  it('rejects incomplete and altered actual test receipts', () => {
    for (const change of [
      (i: ReturnType<typeof fixture>) => {
        i.checks = [];
      },
      i => {
        i.requiredChecks = [];
      },
      i => {
        i.checks[0].exitCode = 1;
      },
      i => {
        i.checks[0].truncated = true;
      },
      i => {
        i.checks[0].skipped = 1;
      },
      i => {
        i.checks[0].assertions = 0;
      },
      i => {
        i.checks[0].output += 'changed';
      },
      i => {
        i.checks[0].sourceTree = '0'.repeat(40);
      },
      i => {
        i.checks[0].image = 'sha256:' + '0'.repeat(64);
      },
      i => {
        i.requiredChecks[0].commandHash = '0'.repeat(64);
      },
    ] satisfies ((i: ReturnType<typeof fixture>) => void)[]) {
      const input = fixture();
      change(input);
      expect(() => assembleTeeTimeReviewPackage(input)).toThrow();
    }
  });
  it('rejects a consistently foreign project and workflow', () => {
    const input = fixture();
    input.authority.canonicalRemote = 'https://github.com/other/project.git';
    input.authority.workflowName = 'foreign';
    input.reviewedWorkflow.name = 'foreign';
    input.expectedPolicy.workflowDigest = policyDigest(input.reviewedWorkflow);
    input.run.metadata!.execution_policy = { ...input.expectedPolicy };
    input.binding.authorityHash = policyDigest(input.authority);
    expect(() => assembleTeeTimeReviewPackage(input)).toThrow();
  });
  it('rejects malformed UTF-8 or unpaired surrogate text without replacement', () => {
    const invalid = fixture();
    invalid.specBytes = new Uint8Array([0xc3, 0x28]);
    expect(() => assembleTeeTimeReviewPackage(invalid)).toThrow();
    const diff = fixture();
    diff.git.diffText = 'bad\ud800';
    expect(() => assembleTeeTimeReviewPackage(diff)).toThrow();
    const tests = fixture();
    tests.checks[0].output = 'bad\ud800';
    tests.checks[0].outputHash = evidenceHash(tests.checks[0].output);
    expect(() => assembleTeeTimeReviewPackage(tests)).toThrow();
  });
  it('blocks oversized, substituted or asynchronous serialized request bytes', () => {
    const big = fixture();
    big.git.diffText = 'x'.repeat(5000);
    expect(() => assembleTeeTimeReviewPackage(big)).toThrow('bound');
    const wrong = fixture();
    wrong.serializeRequest = () => serialize('foreign');
    expect(() => assembleTeeTimeReviewPackage(wrong)).toThrow();
    const asyncInput = fixture();
    asyncInput.serializeRequest = (() => Promise.resolve('')) as unknown as typeof serialize;
    expect(() => assembleTeeTimeReviewPackage(asyncInput)).toThrow();
  });
});
