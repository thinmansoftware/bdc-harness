import type { M42Slice8BManifestPayload } from './m42-slice8b-manifest';
import type { M42Slice8BProcessHealthReceipt } from './m42-slice8b-process-health';
import type { M42Slice8BRunnerReceipt } from './m42-slice8b-canary-runner';

export const M42_SLICE8B_PACKET_STATUS = 'READY_FOR_SANDBOX_PROOF_REQUEST';
export const M42_SLICE8B_RUNTIME_NOT_READY_VERDICT = 'BUILD_READY_NOT_RUNTIME_READY';

export interface M42Slice8BCommandOutcome {
  readonly command: string;
  readonly exit_code: number;
  readonly outcome: string;
}

export interface M42Slice8BAcceptanceEvidence {
  readonly fusion_red_team_tiebreak_panel_verdict: 'pending' | 'accepted' | 'rejected';
  readonly john_countersign: 'pending' | 'signed' | 'rejected';
  readonly independent_non_builder: string;
  readonly exact_head_review_verdict: 'pending' | 'accepted' | 'rejected';
}

export interface M42Slice8BEvidencePacket {
  readonly schema_version: 'm42-slice8b-evidence-packet-v1';
  readonly status: typeof M42_SLICE8B_PACKET_STATUS;
  readonly runtime_honesty_verdict:
    | 'RUNTIME_HEALTHY'
    | typeof M42_SLICE8B_RUNTIME_NOT_READY_VERDICT;
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly corrective_wo_merge_ancestors: Readonly<Record<string, string>>;
  readonly test_commands: readonly M42Slice8BCommandOutcome[];
  readonly ci_evidence: {
    readonly ubuntu: M42Slice8BCommandOutcome;
    readonly windows: M42Slice8BCommandOutcome;
    readonly docker: M42Slice8BCommandOutcome;
  };
  readonly independent_acceptance: M42Slice8BAcceptanceEvidence;
  readonly action_policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly sandbox_manifest_schema: string;
  readonly redacted_principal_identifier: string;
  readonly rollback_commands: readonly M42Slice8BCommandOutcome[];
  readonly fake_rollback_evidence: readonly string[];
  readonly m28_blind_calibration_artifact_digest: string;
  readonly xo_briefing_artifact_digest: string;
  readonly no_secret_scan: M42Slice8BCommandOutcome;
  readonly ascii_checks: readonly M42Slice8BCommandOutcome[];
  readonly no_real_provider_call: true;
  readonly no_real_provider_call_observation: {
    readonly real_provider_call_count: number;
    readonly fake_provider_call_count: number;
  };
  readonly no_paid_fusion_call: true;
  readonly no_paid_fusion_call_observation: {
    readonly paid_fusion_call_count: number;
    readonly fake_fusion_logic_count: number;
  };
  readonly no_production_mutation: true;
  readonly no_production_mutation_observation: {
    readonly production_mutation_count: number;
  };
  readonly no_activation: true;
  readonly no_deployment: true;
  readonly m66_freeze_checklist: readonly string[];
  readonly runner_receipt: M42Slice8BRunnerReceipt;
  readonly process_health: M42Slice8BProcessHealthReceipt;
}

export function buildM42Slice8BEvidencePacket(input: {
  readonly manifest: M42Slice8BManifestPayload;
  readonly runner_receipt: M42Slice8BRunnerReceipt;
  readonly process_health: M42Slice8BProcessHealthReceipt;
  readonly image_digest: string;
  readonly test_commands: readonly M42Slice8BCommandOutcome[];
  readonly ci_evidence: M42Slice8BEvidencePacket['ci_evidence'];
  readonly independent_acceptance: M42Slice8BAcceptanceEvidence;
  readonly rollback_commands: readonly M42Slice8BCommandOutcome[];
  readonly fake_rollback_evidence: readonly string[];
  readonly m28_blind_calibration_artifact_digest: string;
  readonly xo_briefing_artifact_digest: string;
  readonly no_secret_scan: M42Slice8BCommandOutcome;
  readonly ascii_checks: readonly M42Slice8BCommandOutcome[];
}): M42Slice8BEvidencePacket {
  return {
    schema_version: 'm42-slice8b-evidence-packet-v1',
    status: M42_SLICE8B_PACKET_STATUS,
    runtime_honesty_verdict: input.process_health.verdict,
    candidate_sha: input.manifest.candidate_sha,
    image_digest: input.manifest.image_digest,
    corrective_wo_merge_ancestors: {
      ...input.manifest.sibling_merge_ancestor_shas,
      'WO-HARNESS-OVERSEER-S8B-REAL-CANARY-RUNNER-01': input.manifest.candidate_sha,
    },
    test_commands: input.test_commands,
    ci_evidence: input.ci_evidence,
    independent_acceptance: input.independent_acceptance,
    action_policy_digest: input.manifest.action_policy_digest,
    verifier_registry_digest: input.manifest.verifier_registry_digest,
    sandbox_manifest_schema: input.manifest.schema_version,
    redacted_principal_identifier: redactPrincipal(input.manifest.credential_principal_id),
    rollback_commands: input.rollback_commands,
    fake_rollback_evidence: input.fake_rollback_evidence,
    m28_blind_calibration_artifact_digest: input.m28_blind_calibration_artifact_digest,
    xo_briefing_artifact_digest: input.xo_briefing_artifact_digest,
    no_secret_scan: input.no_secret_scan,
    ascii_checks: input.ascii_checks,
    no_real_provider_call: true,
    no_real_provider_call_observation: {
      real_provider_call_count: input.runner_receipt.provider_call_count,
      fake_provider_call_count: input.runner_receipt.fake_provider_call_count,
    },
    no_paid_fusion_call: true,
    no_paid_fusion_call_observation: {
      paid_fusion_call_count: input.runner_receipt.fusion_call_count,
      fake_fusion_logic_count: input.runner_receipt.fake_fusion_logic_count,
    },
    no_production_mutation: true,
    no_production_mutation_observation: {
      production_mutation_count: input.runner_receipt.production_mutation_count,
    },
    no_activation: true,
    no_deployment: true,
    m66_freeze_checklist: [
      'candidate_sha',
      'image_digest',
      'repository_full_name',
      'provider_repository_id',
      'sandbox_base_branch',
      'starting_sha',
      'expected_branch_and_pr_fixtures',
      'rollback_branch',
      'final_expected_state',
      'credential_principal_identifier',
      'action_policy_digest',
      'verifier_registry_digest',
      'm28_blind_calibration_artifact_digest',
      'four_expected_actions_zero_unexpected_actions',
      'sixty_minute_limit',
      'one_attempt_rule',
      'fusion_per_call_daily_monthly_caps',
      'expected_maximum_total_spend',
      'zero_production_effect',
      'circuit_breaker_owner',
      'reconciliation_owner',
      'xo_briefing_format_and_verifier',
      'eligible_advisory_approvals',
      'john_explicit_approval',
    ],
    runner_receipt: input.runner_receipt,
    process_health: input.process_health,
  };
}

function redactPrincipal(value: string): string {
  if (value.length <= 8) return 'redacted';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
