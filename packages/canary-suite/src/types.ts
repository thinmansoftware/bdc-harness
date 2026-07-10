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
