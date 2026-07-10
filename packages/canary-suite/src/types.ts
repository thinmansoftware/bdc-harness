export const CANARY_LANES = [
  'bdc-feature-development-zero-open',
  'bdc-feature-development-zero',
  'bdc-feature-development-fusion-cx-qwen',
  'bdc-feature-development-codex-only',
  'bdc-feature-development-codex',
  'bdc-feature-development',
  'bdc-feature-development-fable',
  'bdc-multi-stage-development',
] as const;

export type CanaryLaneName = (typeof CANARY_LANES)[number];
export type CanaryVerdict = 'passed' | 'failed' | 'blocked' | 'aborted';

export interface LaneManifest {
  readonly name: CanaryLaneName;
  readonly order: number;
}

export interface ConductorProbe {
  readonly id: string;
  readonly woClass?: 'CODE' | 'INFRA' | 'MIXED';
  readonly tags: readonly string[];
  readonly expectedTier: string;
  readonly expectedWorkflow: CanaryLaneName;
}

export interface CanaryManifest {
  readonly schemaVersion: 1;
  readonly environment: {
    readonly id: 'hetzner-production';
    readonly project: 'bdc-harness';
    readonly canonicalRemote: 'bluedevilcollectibles/bdc-harness';
    readonly baseBranch: 'dev';
  };
  readonly artifactRoot: string;
  readonly lanes: readonly LaneManifest[];
  readonly conductorProbes: readonly ConductorProbe[];
}

export interface CanaryWorkflowSnapshot {
  readonly name: string;
  readonly source: 'project' | 'bundled' | 'global';
  readonly revision: string;
  readonly capabilityIssues: readonly string[];
}

export interface CanaryProviderSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly builtIn: boolean;
  readonly capabilities: {
    readonly execution: {
      readonly text: boolean;
      readonly repositoryRead: boolean;
      readonly repositoryWrite: boolean;
      readonly shell: boolean;
    };
    readonly sessionResume: boolean;
    readonly mcp: boolean;
    readonly hooks: boolean;
    readonly skills: boolean;
    readonly agents: boolean;
    readonly toolRestrictions: boolean;
    readonly structuredOutput: boolean;
    readonly envInjection: boolean;
    readonly costControl: boolean;
    readonly effortControl: boolean;
    readonly thinkingControl: boolean;
    readonly fallbackModel: boolean;
    readonly sandbox: boolean;
  };
}

export interface CanarySnapshot {
  readonly observedAt: string;
  readonly codebase: {
    readonly id: string;
    readonly canonicalRemote: string;
    readonly defaultCwd: string;
    readonly baseBranch: 'dev';
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly revisions: {
    readonly engineRevision: string;
    readonly bundleRevision: string;
    readonly runtimeImageRevision: string | null;
  };
  readonly drain: {
    readonly mode: 'normal' | 'draining';
    readonly drained: boolean;
    readonly activeLeaseCount: number;
    readonly activeRunCount: number;
    readonly activeRunIds: readonly string[];
    readonly updatedAt: string | null;
  };
  readonly workflows: readonly CanaryWorkflowSnapshot[];
  readonly providers: readonly CanaryProviderSnapshot[];
  readonly loaderErrors: readonly {
    readonly filename: string;
    readonly path?: string;
    readonly error: string;
    readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
  }[];
  readonly ladder: {
    readonly tiers: readonly {
      readonly name: string;
      readonly workflowName: string;
      readonly isFrontier: boolean;
    }[];
  };
  readonly ruleset: {
    readonly defaultEntry: string;
    readonly rules: readonly {
      readonly match: { readonly woClass?: string; readonly tags?: readonly string[] };
      readonly entry: string;
    }[];
  };
}

export interface CanaryDirectRoute {
  readonly lane: CanaryLaneName;
  readonly matches: readonly CanaryWorkflowSnapshot[];
}

export interface CanaryConductorRoute {
  readonly probeId: string;
  readonly expectedTier: string;
  readonly expectedWorkflow: CanaryLaneName;
  readonly tier: string;
  readonly workflowName: string | null;
}

export interface CanaryPlan {
  readonly requestId: string;
  readonly manifest: CanaryManifest;
  readonly snapshot: CanarySnapshot;
  readonly directRoutes: readonly CanaryDirectRoute[];
  readonly conductorRoutes: readonly CanaryConductorRoute[];
}

export interface CanaryReduction {
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface CanaryLaneReport {
  readonly lane: CanaryLaneName;
  readonly level: 0 | 1;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly workflowRevision: string | null;
  readonly capabilityStatus: 'passed' | 'failed' | 'missing' | 'duplicate';
  readonly evidenceRefs: readonly string[];
}

export interface CanaryReport {
  readonly schemaVersion: 1;
  readonly suiteRunId: string;
  readonly level: 0 | 1;
  readonly generatedAt: string;
  readonly requestId: string;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly lanes: readonly CanaryLaneReport[];
}

export interface RunCanaryResult {
  readonly plan: CanaryPlan;
  readonly report: CanaryReport;
  readonly artifactPaths: readonly string[];
}
