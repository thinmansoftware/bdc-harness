import { describe, expect, test } from 'bun:test';
import {
  M42_SLICE8B_PACKET_STATUS,
  M42_SLICE8B_RUNTIME_NOT_READY_VERDICT,
  buildM42Slice8BEvidencePacket,
} from '../m42-slice8b-evidence-packet';
import {
  M42_SLICE8B_MANIFEST_SCHEMA,
  type M42Slice8BManifestPayload,
} from '../m42-slice8b-manifest';
import type { M42Slice8BRunnerReceipt } from '../m42-slice8b-canary-runner';
import type { M42Slice8BProcessHealthReceipt } from '../m42-slice8b-process-health';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST = `sha256:${'3'.repeat(64)}`;

function command(commandText: string, outcome = 'ok') {
  return { command: commandText, exit_code: 0, outcome };
}

function manifest(): M42Slice8BManifestPayload {
  return {
    schema_version: M42_SLICE8B_MANIFEST_SCHEMA,
    execution_id: 'exec-s8b-packet',
    mode: 'fake',
    candidate_sha: SHA_A,
    starting_sha: SHA_B,
    repository_full_name: 'thinmansoftware/bdc-harness',
    provider_repository_id: 'R_sandbox_123',
    credential_principal_id: 'principal-sandbox-only-1234',
    image_digest: DIGEST,
    fusion_caps_digest: DIGEST,
    verifier_registry_digest: DIGEST,
    action_policy_digest: DIGEST,
    expected_primary_actions: ['REFIRE', 'REFRESH', 'CLOSE', 'MERGE'],
    expected_unexpected_actions: 0,
    max_window_minutes: 60,
    no_production_effect: true,
    declared_rollback_state_digest: DIGEST,
    sibling_merge_ancestor_shas: {
      'S8B-SANDBOX-GH-ADAPTERS-01': SHA_A,
      'S8B-CAULDRON-REFIRE-BRIDGE-01': SHA_B,
      'S8B-FUSION-BUDGET-RECEIPTS-01': 'c'.repeat(40),
    },
    issued_at: '2026-07-17T12:00:00.000Z',
    expires_at: '2026-07-17T13:00:00.000Z',
  };
}

function runnerReceipt(): M42Slice8BRunnerReceipt {
  return {
    schema_version: 'm42-slice8b-canary-runner-receipt-v1',
    ok: true,
    stop_reason: 'completed',
    execution_id: 'exec-s8b-packet',
    attempted_primary_actions: ['REFIRE', 'REFRESH', 'CLOSE', 'MERGE'],
    rollback_actions: ['REOPEN_ROLLBACK'],
    unexpected_action_count: 0,
    provider_call_count: 0,
    fake_provider_call_count: 5,
    fusion_call_count: 0,
    fake_fusion_logic_count: 10,
    production_mutation_count: 0,
    m31_receipt_count: 5,
    provider_receipt_count: 5,
    fusion_budget_receipt_count: 5,
    rollback_receipt_count: 1,
    circuit_breaker_opened: false,
    rollback_verified: true,
    receipts: [],
    xo_briefing_reconciled: true,
  };
}

function processHealth(): M42Slice8BProcessHealthReceipt {
  return {
    schema_version: 'm42-slice8b-process-health-v1',
    verdict: M42_SLICE8B_RUNTIME_NOT_READY_VERDICT,
    healthy_process_count: 0,
    audited_host: 'audited-host-1',
    restart_detected: false,
    recovered: false,
    no_double_action: true,
  };
}

describe('M-42 Slice 8B evidence packet', () => {
  test('contains design section 8 packet items with build-ready-only status', () => {
    const packet = buildM42Slice8BEvidencePacket({
      manifest: manifest(),
      runner_receipt: runnerReceipt(),
      process_health: processHealth(),
      image_digest: DIGEST,
      test_commands: [command('bun test src/__tests__/m42-slice8b-canary-runner.test.ts')],
      ci_evidence: {
        ubuntu: command('ubuntu ci'),
        windows: command('windows ci'),
        docker: command('docker build'),
      },
      independent_acceptance: {
        fusion_red_team_tiebreak_panel_verdict: 'pending',
        john_countersign: 'pending',
        independent_non_builder: 'pending',
        exact_head_review_verdict: 'pending',
      },
      rollback_commands: [command('fake rollback')],
      fake_rollback_evidence: ['rollback_state_digest matched declared state'],
      m28_blind_calibration_artifact_digest: DIGEST,
      xo_briefing_artifact_digest: DIGEST,
      no_secret_scan: command('gitleaks detect --no-banner --redact --source .'),
      ascii_checks: [command('ascii changed files')],
    });
    expect(packet.status).toBe(M42_SLICE8B_PACKET_STATUS);
    expect(packet.runtime_honesty_verdict).toBe('BUILD_READY_NOT_RUNTIME_READY');
    expect(packet.no_real_provider_call).toBe(true);
    expect(packet.no_real_provider_call_observation).toEqual({
      real_provider_call_count: 0,
      fake_provider_call_count: 5,
    });
    expect(packet.no_paid_fusion_call).toBe(true);
    expect(packet.no_paid_fusion_call_observation).toEqual({
      paid_fusion_call_count: 0,
      fake_fusion_logic_count: 10,
    });
    expect(packet.no_production_mutation).toBe(true);
    expect(packet.no_production_mutation_observation).toEqual({
      production_mutation_count: 0,
    });
    expect(packet.no_activation).toBe(true);
    expect(packet.no_deployment).toBe(true);
    expect(packet.image_digest).toBe(DIGEST);
    expect(packet.redacted_principal_identifier).toBe('prin...1234');
    expect(packet.corrective_wo_merge_ancestors).toEqual({
      'S8B-SANDBOX-GH-ADAPTERS-01': SHA_A,
      'S8B-CAULDRON-REFIRE-BRIDGE-01': SHA_B,
      'S8B-FUSION-BUDGET-RECEIPTS-01': 'c'.repeat(40),
      'WO-HARNESS-OVERSEER-S8B-REAL-CANARY-RUNNER-01': SHA_A,
    });
    expect(packet.independent_acceptance.fusion_red_team_tiebreak_panel_verdict).toBe('pending');
    expect(packet.independent_acceptance.john_countersign).toBe('pending');
    expect(packet.m66_freeze_checklist).toContain('candidate_sha');
    expect(packet.m66_freeze_checklist).toContain('john_explicit_approval');
  });
});
