import { DEFAULT_REVIEWERS } from '../config';
import type { ReviewerConfig } from '../types';

export interface FusionConfigTemplate {
  outputRoot: string;
  round: 1;
  manifestSchemaVersion: 2;
  reviewers: ReviewerConfig[];
}

export const DEFAULT_FUSION_CONFIG_TEMPLATE: FusionConfigTemplate = {
  outputRoot: 'fusion-runs',
  round: 1,
  manifestSchemaVersion: 2,
  reviewers: DEFAULT_REVIEWERS,
};
