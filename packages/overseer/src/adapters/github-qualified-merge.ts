import { createHash } from 'node:crypto';
import type {
  QualifiedMergeAdapterResultV2,
  QualifiedMergeAdapterV2,
} from '../actions/merge-ready.ts';

export interface GitHubQualifiedMergeClient {
  readonly pulls: {
    merge(input: {
      readonly owner: string;
      readonly repo: string;
      readonly pull_number: number;
      readonly sha: string;
    }): Promise<{ readonly data: { readonly merged: boolean; readonly sha?: string | null } }>;
  };
}

function result(
  status: QualifiedMergeAdapterResultV2['status'],
  reason: string,
  externalEffectReference: string | null,
  evidenceDigest: string | null
): QualifiedMergeAdapterResultV2 {
  return {
    schema_version: 'overseer-qualified-merge-adapter-result-v2',
    status,
    reason,
    external_effect_reference: externalEffectReference,
    evidence_digest: evidenceDigest,
  };
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  return typeof error.status === 'number' ? error.status : null;
}

/**
 * Policy-free provider boundary. All authority and evidence checks belong to
 * the qualified merge executor before this adapter is called.
 */
export function createGitHubQualifiedMergeAdapter(
  client: GitHubQualifiedMergeClient
): QualifiedMergeAdapterV2 {
  return {
    async attemptMerge(request): Promise<QualifiedMergeAdapterResultV2> {
      const parts = request.repository.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return result('failed', 'github_repository_invalid', null, null);
      }
      const [owner, repo] = parts;
      try {
        const response = await client.pulls.merge({
          owner,
          repo,
          pull_number: request.pr_number,
          sha: request.head_sha,
        });
        if (!response.data.merged) {
          return result('failed', 'github_merge_not_merged', null, null);
        }
        const reference = `${request.repository}#${request.pr_number}@${request.head_sha}`;
        const digest = createHash('sha256')
          .update(
            JSON.stringify({
              merged: true,
              repository: request.repository,
              pr_number: request.pr_number,
              requested_head_sha: request.head_sha,
              provider_sha: response.data.sha ?? null,
            })
          )
          .digest('hex');
        return result('succeeded', 'github_merge_accepted', reference, digest);
      } catch (error) {
        const status = httpStatus(error);
        if (status === 409 || status === 422) {
          return result('failed', `github_merge_rejected_${status}`, null, null);
        }
        return result('indeterminate', 'github_merge_transport_ambiguous', null, null);
      }
    },
  };
}
