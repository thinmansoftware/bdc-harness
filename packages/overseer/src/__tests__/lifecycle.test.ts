import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import {
  assessLifecycleCandidate as exportedAssessLifecycleCandidate,
  createLifecycleMutationAdapter as exportedCreateLifecycleMutationAdapter,
} from '..';
import {
  createLifecycleMutationAdapter,
  reconcileLifecycleResult,
  type LifecycleMutationAdapterV1,
} from '../adapters/lifecycle';
import {
  assessLifecycleCandidate,
  buildReopenRecipe,
  executeLifecycleAction,
  verifySalvageArtifact,
  type ExecuteLifecycleActionDepsV1,
  type ExecuteLifecycleActionInputV1,
  type InjectedActionPolicyDepsV1,
  type LifecycleActionKindV1,
  type LifecycleCandidateInputV1,
  type LifecycleGateDepsV1,
  type LifecycleLineageEvidenceV1,
  type LifecycleTargetBindingV1,
  type OverseerSalvageReceiptV1,
  type SalvageArtifactDepsV1,
} from '../actions/lifecycle';

// ---------------------------------------------------------------------------
// Real local-Git fixture helpers. These live in the (unlinted, un-type-checked)
// test file only; the two source files never shell out or import a Git package.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).trim();
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function initRepoWithCommit(): { repo: string; commit: string } {
  const repo = makeTempDir('lifecycle-repo-');
  git(repo, ['init', '--initial-branch', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.com']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'file.txt'), 'salvage\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'salvage']);
  return { repo, commit: git(repo, ['rev-parse', 'HEAD']) };
}

function gitSalvageDeps(): SalvageArtifactDepsV1 {
  return {
    async artifactExists({ worktree_path, artifact_kind, git_object_id, patch_path }) {
      if (artifact_kind === 'git_object') {
        try {
          execFileSync('git', ['cat-file', '-e', `${git_object_id}^{object}`], {
            cwd: worktree_path,
            stdio: 'ignore',
          });
          return true;
        } catch {
          return false;
        }
      }
      if (!patch_path) return false;
      try {
        execFileSync('test', ['-f', join(worktree_path, patch_path)]);
        return true;
      } catch {
        return false;
      }
    },
    async digestPatch({ worktree_path, patch_path }) {
      try {
        const content = execFileSync('cat', [join(worktree_path, patch_path)]);
        return createHash('sha256').update(content).digest('hex');
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared lifecycle fixtures.
// ---------------------------------------------------------------------------

const DIGEST_A = sha256hex('target-a');
const DIGEST_B = sha256hex('target-b');
const POLICY_DIGEST = sha256hex('policy');
const REGISTRY_DIGEST = sha256hex('registry');
const PARAMS_DIGEST = sha256hex('params');

function targetBinding(overrides: Partial<LifecycleTargetBindingV1> = {}): LifecycleTargetBindingV1 {
  return {
    repository: 'bluedevilcollectibles/bdc-harness',
    target_kind: 'pull_request',
    target_key: 'pr:101',
    target_digest: DIGEST_A,
    snapshot_id: 'snapshot-1',
    target: {
      target_kind: 'pull_request',
      repository: 'bluedevilcollectibles/bdc-harness',
      pr_number: 101,
      provider_node_id: 'PR_node_101',
      head_sha: 'a'.repeat(40),
      base_branch: 'dev',
      base_sha: 'b'.repeat(40),
      state: 'open',
      updated_at: '2026-07-16T00:00:00.000Z',
    },
    ...overrides,
  };
}

function lineage(overrides: Partial<LifecycleLineageEvidenceV1> = {}): LifecycleLineageEvidenceV1 {
  return {
    kind: 'duplicate',
    predecessor_target_key: 'pr:100',
    successor_target_key: 'pr:101',
    predecessor_digest: DIGEST_B,
    successor_digest: DIGEST_A,
    exact_match: true,
    uncertain: false,
    ...overrides,
  };
}

function salvage(overrides: Partial<OverseerSalvageReceiptV1> = {}): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-TEST-LIFECYCLE',
    source_target_kind: 'pull_request',
    source_target_key: 'pr:100',
    source_target_digest: DIGEST_B,
    source_run_id: null,
    worktree_path: '/tmp/lifecycle',
    artifact_kind: 'git_object',
    git_object_format: 'sha1',
    git_object_id: 'a'.repeat(40),
    patch_path: null,
    patch_sha256: null,
    scope_digest: sha256hex('scope'),
    captured_at: '2026-07-16T00:00:00.000Z',
    verified_at: '2026-07-16T00:00:01.000Z',
    ...overrides,
  };
}

function candidate(
  action_kind: LifecycleCandidateInputV1['action_kind'],
  overrides: Partial<LifecycleCandidateInputV1> = {}
): LifecycleCandidateInputV1 {
  return {
    lifecycle_gate_enabled: true,
    evidence_complete: true,
    target: targetBinding(),
    action_kind,
    action_parameters_digest: PARAMS_DIGEST,
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: REGISTRY_DIGEST,
    salvage_receipt: action_kind === 'CLOSE' ? salvage() : null,
    lineage: action_kind === 'CLOSE' ? lineage() : null,
    reopen_evidence:
      action_kind === 'REOPEN'
        ? {
            close_proposal_id: 'proposal-close-1',
            close_execution_id: 'exec-close-1',
            false_observation_digest: sha256hex('false-close'),
            proven_false: true,
            protected_boundary_clear: true,
          }
        : null,
    verifier: {
      verifier_identity: 'reviewer',
      verifier_provider: 'provider-b',
      verifier_model_family: 'family-b',
      operator_identity: 'builder',
      operator_provider: 'provider-a',
      operator_model_family: 'family-a',
      verdict: 'APPROVE',
      reviewed_target_digest: DIGEST_A,
      reviewed_action_kind: action_kind === 'READ_ONLY' ? 'COMMENT' : action_kind,
      raw_dissent_recorded: true,
    },
    fusion: { required: true, present: true, receipt_digest: sha256hex('fusion') },
    protected_boundaries: [],
    customer_contact: false,
    governance_filing: false,
    ...overrides,
  };
}

function eligiblePolicy(): InjectedActionPolicyDepsV1 {
  return {
    evaluateActionPolicy(input) {
      return {
        eligible: true,
        effect_allowed: true,
        action_parameters_digest: input.action_parameters_digest,
      };
    },
  };
}

interface ReceiptStub {
  receipt_event_id: string;
  event_type: string;
  event_sequence: number;
}

function receipt(eventType: string, sequence: number): ReceiptStub {
  return {
    receipt_event_id: `receipt-${eventType}-${sequence}`,
    event_type: eventType,
    event_sequence: sequence,
  };
}

function makeGate(
  order: string[],
  opts: {
    prepareDenied?: string;
    authDenied?: string;
    reserveFailure?: string;
    recordFailure?: string;
  } = {}
): LifecycleGateDepsV1 {
  return {
    async preparePermit({ proposal_id }) {
      order.push('prepare');
      if (opts.prepareDenied) return { ok: false, denied: opts.prepareDenied };
      return {
        ok: true,
        permit: {
          permit_id: `permit-${proposal_id}`,
          proposal_id,
          execution_id: `exec-${proposal_id}`,
          repository: 'bluedevilcollectibles/bdc-harness',
          target: targetBinding().target,
          target_key: 'pr:101',
          target_digest: DIGEST_A,
          snapshot_id: 'snapshot-1',
          action_kind: 'CLOSE',
          capability: 'overseer.m31.lifecycle',
          issued_at: '2026-07-16T00:00:00.000Z',
          valid_until: '2026-07-16T00:10:00.000Z',
        } as never,
        receipt: receipt('permit_issued', 1) as never,
      };
    },
    async authorizeLifecycleAction() {
      order.push('authorize');
      if (opts.authDenied) return { allowed: false, reason: opts.authDenied };
      return { allowed: true };
    },
    async reserveEffect() {
      order.push('reserve');
      if (opts.reserveFailure) return { ok: false, failure: opts.reserveFailure as never };
      return { ok: true, receipt: receipt('effect_reserved', 2) as never };
    },
    async recordOutcome({ outcome }) {
      order.push(`outcome:${outcome}`);
      if (opts.recordFailure) return { ok: false, failure: opts.recordFailure as never };
      return { ok: true, receipt: receipt(outcome, 3) as never };
    },
  };
}

function makeDeps(
  adapter: LifecycleMutationAdapterV1,
  order: string[],
  opts: { liveDigest?: string; policy?: InjectedActionPolicyDepsV1; gate?: LifecycleGateDepsV1 } = {}
): ExecuteLifecycleActionDepsV1 {
  return {
    policy: opts.policy ?? eligiblePolicy(),
    salvage: {
      async artifactExists() {
        order.push('salvage');
        return true;
      },
      async digestPatch() {
        return null;
      },
    },
    async observeLiveTarget() {
      order.push('observe');
      return {
        target_digest: opts.liveDigest ?? DIGEST_A,
        state: 'open',
        policy_digest: POLICY_DIGEST,
        verifier_registry_digest: REGISTRY_DIGEST,
      };
    },
    gate: opts.gate ?? makeGate(order),
    adapter,
  };
}

function execInput(action_kind: LifecycleActionKindV1): ExecuteLifecycleActionInputV1 {
  return {
    candidate: candidate(action_kind),
    proposal_id: `proposal-${action_kind.toLowerCase()}`,
    actor: 'overseer',
    correlation_id: `corr-${action_kind.toLowerCase()}`,
  };
}

describe('lifecycle assessment', () => {
  test('public package boundary exposes lifecycle action and adapter helpers', () => {
    expect(exportedAssessLifecycleCandidate).toBe(assessLifecycleCandidate);
    expect(exportedCreateLifecycleMutationAdapter).toBe(createLifecycleMutationAdapter);
  });

  test('age-only close denied before permit and adapter', async () => {
    const order: string[] = [];
    const adapter = { perform: mock(async () => undefined as never) };
    const result = await executeLifecycleAction(
      {
        ...execInput('CLOSE'),
        candidate: candidate('CLOSE', { lineage: null }),
      },
      makeDeps(adapter, order)
    );
    expect(result.outcome).toBe('denied');
    expect(result.reason).toBe('exact_lineage_required');
    expect(order).toEqual([]);
    expect(adapter.perform).toHaveBeenCalledTimes(0);
  });

  test('customer and governance content denied at assessment', () => {
    expect(
      assessLifecycleCandidate(candidate('COMMENT', { customer_contact: true }), {
        policy: eligiblePolicy(),
      })
    ).toMatchObject({ disposition: 'denied', reason: 'protected_boundary' });
    expect(
      assessLifecycleCandidate(candidate('COMMENT', { governance_filing: true }), {
        policy: eligiblePolicy(),
      })
    ).toMatchObject({ disposition: 'denied', reason: 'protected_boundary' });
  });
});

describe('lifecycle execution', () => {
  test('verified duplicate close preserves membership evidence and emits one result receipt', async () => {
    const order: string[] = [];
    const adapter = createLifecycleMutationAdapter({
      allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
      allowed_actions: ['CLOSE'],
      async consume_execution() {
        order.push('adapter');
        return true;
      },
    });
    const result = await executeLifecycleAction(execInput('CLOSE'), makeDeps(adapter, order));
    expect(result.outcome).toBe('succeeded');
    expect(result.receipt_types).toEqual([
      'permit_issued',
      'effect_reserved',
      'effect_succeeded',
    ]);
    expect(order).toEqual(['salvage', 'prepare', 'authorize', 'reserve', 'observe', 'adapter', 'outcome:effect_succeeded']);

    const reconciled = reconcileLifecycleResult({
      snapshot_id: 'snapshot-1',
      original_member_target_key: 'pr:100',
      wo_id: 'WO-TEST-LIFECYCLE',
      issue_or_pr_key: 'pr:101',
      run_id: 'run-1',
      card_id: 'card-1',
      mutation: {
        adapter: 'fake-lifecycle',
        accepted: true,
        reason: 'fake_accepted',
        mutation_sent: false,
        external_effect_reference: result.external_effect_reference,
        permit_id: 'permit-1',
        execution_id: 'exec-1',
        repository: 'bluedevilcollectibles/bdc-harness',
        target_kind: 'pull_request',
        target_key: 'pr:101',
        target_digest: DIGEST_A,
        action_kind: 'CLOSE',
        action_parameters_digest: PARAMS_DIGEST,
      },
      existing_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('existing'),
        },
      ],
      new_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('new'),
        },
      ],
    });
    expect(reconciled.preserved_member_target_key).toBe('pr:100');
    expect(reconciled.membership_collapsed).toBe(false);
    expect(reconciled.lineage).toHaveLength(2);
  });

  test('mistaken close reopens same fake target and links corrective evidence', async () => {
    const order: string[] = [];
    const adapter = createLifecycleMutationAdapter({
      allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
      allowed_actions: ['REOPEN'],
      async consume_execution() {
        order.push('adapter');
        return true;
      },
    });
    const result = await executeLifecycleAction(execInput('REOPEN'), makeDeps(adapter, order));
    expect(result.outcome).toBe('succeeded');
    expect(result.action_kind).toBe('REOPEN');
    expect(candidate('REOPEN').reopen_evidence).toMatchObject({
      close_proposal_id: 'proposal-close-1',
      proven_false: true,
    });
  });

  test('comment label and assign execute through one allowlisted fake mutation each', async () => {
    for (const action of ['COMMENT', 'LABEL', 'ASSIGN'] as const) {
      const adapter = createLifecycleMutationAdapter({
        allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
        allowed_actions: [action],
        async consume_execution() {
          return true;
        },
      });
      const order: string[] = [];
      const result = await executeLifecycleAction(execInput(action), makeDeps(adapter, order));
      expect(result.outcome).toBe('succeeded');
      expect(result.action_kind).toBe(action);
    }
  });

  test('self-review stale evidence and policy drift fail closed before adapter invocation', async () => {
    const adapter = { perform: mock(async () => undefined as never) };
    const selfReview = await executeLifecycleAction(
      {
        ...execInput('COMMENT'),
        candidate: candidate('COMMENT', {
          verifier: {
            ...candidate('COMMENT').verifier!,
            verifier_identity: 'builder',
          },
        }),
      },
      makeDeps(adapter, [])
    );
    expect(selfReview.outcome).toBe('denied');

    const driftOrder: string[] = [];
    const liveDrift = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(adapter, driftOrder, { liveDigest: DIGEST_B })
    );
    expect(liveDrift.outcome).toBe('live_state_mismatch');
    expect(adapter.perform).toHaveBeenCalledTimes(0);

    const policyDrift = await executeLifecycleAction(
      execInput('COMMENT'),
      makeDeps(adapter, [], {
        policy: {
          evaluateActionPolicy() {
            return {
              eligible: true,
              effect_allowed: true,
              action_parameters_digest: sha256hex('stale'),
            };
          },
        },
      })
    );
    expect(policyDrift.outcome).toBe('denied');
    expect(adapter.perform).toHaveBeenCalledTimes(0);
  });
});

describe('salvage verification and floors', () => {
  test('salvage and lineage remain append only', async () => {
    const { repo, commit } = initRepoWithCommit();
    const validGit = salvage({ worktree_path: repo, git_object_id: commit });
    expect(await verifySalvageArtifact(validGit, gitSalvageDeps())).toMatchObject({ ok: true });

    const missingGit = salvage({ worktree_path: repo, git_object_id: 'f'.repeat(40) });
    expect(await verifySalvageArtifact(missingGit, gitSalvageDeps())).toMatchObject({
      ok: false,
      reason: 'git_object_missing',
    });

    writeFileSync(join(repo, 'salvage.patch'), 'patch-content\n');
    const validPatch = salvage({
      worktree_path: repo,
      artifact_kind: 'patch',
      git_object_format: null,
      git_object_id: null,
      patch_path: 'salvage.patch',
      patch_sha256: sha256hex('patch-content\n'),
    });
    expect(await verifySalvageArtifact(validPatch, gitSalvageDeps())).toMatchObject({ ok: true });
    expect(
      await verifySalvageArtifact(
        { ...validPatch, patch_sha256: sha256hex('corrupt') },
        gitSalvageDeps()
      )
    ).toMatchObject({ ok: false, reason: 'patch_digest_mismatch' });

    const recipe = buildReopenRecipe({
      target: targetBinding(),
      close_proposal_id: 'proposal-close-1',
      close_execution_id: 'exec-close-1',
      required_observation_digest: DIGEST_A,
      action_parameters_digest: PARAMS_DIGEST,
    });
    expect(recipe.inverse_provider_action).toBe('REOPEN');
    const reconciled = reconcileLifecycleResult({
      snapshot_id: 'snapshot-1',
      original_member_target_key: 'pr:100',
      wo_id: 'WO-TEST-LIFECYCLE',
      issue_or_pr_key: 'pr:101',
      run_id: 'run-1',
      card_id: 'card-1',
      mutation: {
        adapter: 'fake-lifecycle',
        accepted: true,
        reason: 'fake_accepted',
        mutation_sent: false,
        external_effect_reference: 'fake://close',
        permit_id: 'permit-1',
        execution_id: 'exec-1',
        repository: 'bluedevilcollectibles/bdc-harness',
        target_kind: 'pull_request',
        target_key: 'pr:101',
        target_digest: DIGEST_A,
        action_kind: 'CLOSE',
        action_parameters_digest: PARAMS_DIGEST,
      },
      existing_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('predecessor'),
        },
      ],
      new_lineage: [
        {
          predecessor_target_key: 'pr:100',
          successor_target_key: 'pr:101',
          evidence_digest: sha256hex('successor'),
        },
      ],
    });
    expect(reconciled.lineage.map(item => item.evidence_digest)).toEqual([
      sha256hex('predecessor'),
      sha256hex('successor'),
    ]);

    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('Fusion and verifier floors fail closed', async () => {
    const deniedCases: LifecycleCandidateInputV1[] = [
      candidate('CLOSE', { fusion: { required: true, present: false, receipt_digest: null } }),
      candidate('CLOSE', {
        verifier: {
          ...candidate('CLOSE').verifier!,
          verifier_provider: 'provider-a',
        },
      }),
      candidate('CLOSE', {
        verifier: {
          ...candidate('CLOSE').verifier!,
          raw_dissent_recorded: false,
        },
      }),
      candidate('REOPEN', {
        reopen_evidence: {
          close_proposal_id: 'proposal-close-1',
          close_execution_id: 'exec-close-1',
          false_observation_digest: sha256hex('false-close'),
          proven_false: false,
          protected_boundary_clear: true,
        },
      }),
    ];

    for (const denied of deniedCases) {
      const adapter = { perform: mock(async () => undefined as never) };
      const result = await executeLifecycleAction(
        {
          candidate: denied,
          proposal_id: 'proposal-denied',
          actor: 'overseer',
          correlation_id: 'corr-denied',
        },
        makeDeps(adapter, [])
      );
      expect(result.outcome).toBe('denied');
      expect(adapter.perform).toHaveBeenCalledTimes(0);
    }
  });
});
