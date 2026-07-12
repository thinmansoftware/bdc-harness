import type { CanaryPlan, CanaryReduction } from './types';
import { verdictForStaticOnly } from './layer3-policy';

export function reduceCanaryPlan(plan: CanaryPlan, level: 0 | 1 = 1): CanaryReduction {
  const failed: { reason: string; evidence: string }[] = [];
  const blocked: { reason: string; evidence: string }[] = [];

  if (plan.snapshot.codebase.canonicalRemote !== plan.manifest.environment.canonicalRemote) {
    failed.push({ reason: 'canonical_remote_mismatch', evidence: 'snapshot:codebase' });
  }
  if (plan.snapshot.codebase.baseBranch !== plan.manifest.environment.baseBranch) {
    failed.push({ reason: 'base_branch_mismatch', evidence: 'snapshot:codebase' });
  }
  for (const route of plan.directRoutes) {
    if (route.matches.length === 0) {
      failed.push({ reason: 'lane_missing', evidence: `workflow:${route.lane}` });
    } else if (route.matches.length > 1) {
      failed.push({ reason: 'lane_duplicate', evidence: `workflow:${route.lane}` });
    }
    if (route.matches.some(workflow => workflow.capabilityIssues.length > 0)) {
      failed.push({ reason: 'capability_mismatch', evidence: `workflow:${route.lane}` });
    }
  }
  if (plan.snapshot.loaderErrors.length > 0) {
    failed.push({ reason: 'workflow_loader_error', evidence: 'snapshot:loaderErrors' });
  }
  if (level === 1) {
    for (const route of plan.conductorRoutes) {
      if (route.tier !== route.expectedTier || route.workflowName !== route.expectedWorkflow) {
        failed.push({ reason: 'conductor_route_mismatch', evidence: `probe:${route.probeId}` });
      }
    }
  }
  if (!plan.snapshot.revisions.runtimeImageRevision?.trim()) {
    blocked.push({
      reason: 'runtime_image_revision_missing',
      evidence: 'snapshot:revisions',
    });
  }
  if (plan.snapshot.drain.mode === 'draining') {
    blocked.push({ reason: 'cauldron_draining', evidence: 'snapshot:drain' });
  }

  const findings = failed.length > 0 ? failed : blocked;
  return {
    verdict: failed.length > 0 ? 'failed' : blocked.length > 0 ? 'blocked' : verdictForStaticOnly(),
    reasonCodes: [...new Set(findings.map(finding => finding.reason))],
    evidenceRefs: [...new Set(findings.map(finding => finding.evidence))],
  };
}
