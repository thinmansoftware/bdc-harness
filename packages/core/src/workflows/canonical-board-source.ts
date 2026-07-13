import { z } from 'zod';

const BDC_XO_REPOSITORY = 'bluedevilcollectibles/bdc-xo';
const BDC_XO_BRANCH = 'main';
const BOARD_MOTION_PREFIX = 'docs/board/motions/';
const BOARD_APPROVAL_FENCE = 'board-approval-v1';

export interface CanonicalBoardSourceDependencies {
  readonly fetcher?: typeof fetch;
  readonly githubToken?: string;
}

export interface FrozenCanonicalBoardMotion {
  readonly repository: typeof BDC_XO_REPOSITORY;
  readonly path: string;
  readonly commit_sha: string;
  readonly blob_sha: string;
  readonly bytes: Uint8Array;
}

export interface ApprovedBoardAction {
  readonly motion_id: string;
  readonly environment: 'production';
  readonly target_sha: string;
  readonly motion_blob_sha: string;
  readonly acting_xo_principal_id: string;
  readonly second_seat_principal_id: string;
  readonly john_principal_id: string;
}

const approvalSchema = z
  .object({
    motion_id: z.string().min(1),
    action: z.literal('approve_production'),
    environment: z.literal('production'),
    target_sha: z.string().regex(/^[0-9a-f]{40}$/),
    no_staging_exception: z.boolean().default(false),
    rollback_test_evidence: z.string().min(1).optional(),
    approvals: z
      .array(
        z
          .object({
            principal_id: z.string().min(1),
            seat_id: z.enum(['john', 'general', 'xo']),
            role: z.enum(['acting_xo', 'second_seat']),
            approved: z.literal(true),
          })
          .strict()
      )
      .length(2),
    john_authorization: z
      .object({
        principal_id: z.string().min(1),
        environment: z.literal('production'),
        target_sha: z.string().regex(/^[0-9a-f]{40}$/),
        authorized: z.literal(true),
        revoked: z.literal(false).optional(),
      })
      .strict(),
  })
  .strict();

type ApprovalRecord = z.infer<typeof approvalSchema>;

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) return {};
  const value: unknown = await response.json();
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export async function freezeCanonicalBoardMotion(
  path: string,
  dependencies: CanonicalBoardSourceDependencies = {}
): Promise<FrozenCanonicalBoardMotion> {
  if (!path.startsWith(BOARD_MOTION_PREFIX) || !path.endsWith('.md') || path.includes('..')) {
    throw new Error('authority_source_invalid: noncanonical motion path');
  }
  const fetcher = dependencies.fetcher ?? fetch;
  const token = dependencies.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!dependencies.fetcher && !token) {
    throw new Error('authority_source_missing: GitHub authentication');
  }
  const headers = githubHeaders(token);

  const refResponse = await fetcher(
    `https://api.github.com/repos/${BDC_XO_REPOSITORY}/git/ref/heads/${BDC_XO_BRANCH}`,
    { headers }
  );
  const refJson = await readJson(refResponse);
  const object = refJson.object;
  const commitSha =
    typeof object === 'object' &&
    object !== null &&
    typeof (object as { sha?: unknown }).sha === 'string'
      ? (object as { sha: string }).sha
      : '';
  if (!commitSha) throw new Error('authority_source_missing: canonical ref');

  const contentResponse = await fetcher(
    `https://api.github.com/repos/${BDC_XO_REPOSITORY}/contents/${encodePath(path)}?ref=${encodeURIComponent(commitSha)}`,
    { headers }
  );
  const contentJson = await readJson(contentResponse);
  if (
    contentJson.type !== 'file' ||
    typeof contentJson.content !== 'string' ||
    typeof contentJson.sha !== 'string'
  ) {
    throw new Error('authority_source_missing: canonical motion');
  }

  const bytes = Buffer.from(contentJson.content.replace(/\s/g, ''), 'base64');
  if (bytes.byteLength === 0) throw new Error('authority_source_missing: canonical motion');
  return {
    repository: BDC_XO_REPOSITORY,
    path,
    commit_sha: commitSha,
    blob_sha: contentJson.sha,
    bytes,
  };
}

export function parseCanonicalBoardApproval(
  motion: FrozenCanonicalBoardMotion
): ApprovedBoardAction {
  const text = Buffer.from(motion.bytes).toString('utf8');
  const record = readApprovalRecord(text);
  validateApprovalRecord(record);
  const actingXo = record.approvals.find(approval => approval.role === 'acting_xo');
  const secondSeat = record.approvals.find(approval => approval.role === 'second_seat');
  if (!actingXo || !secondSeat) throw new Error('canonical_approval_rejected: quorum');
  return {
    motion_id: record.motion_id,
    environment: record.environment,
    target_sha: record.target_sha,
    motion_blob_sha: motion.blob_sha,
    acting_xo_principal_id: actingXo.principal_id,
    second_seat_principal_id: secondSeat.principal_id,
    john_principal_id: record.john_authorization.principal_id,
  };
}

function readApprovalRecord(text: string): ApprovalRecord {
  const fencePattern = new RegExp('```' + BOARD_APPROVAL_FENCE + '\\s*\\n([\\s\\S]*?)\\n```', 'g');
  const matches = [...text.matchAll(fencePattern)];
  if (matches.length !== 1) {
    throw new Error('canonical_approval_rejected: expected one board-approval-v1 block');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0][1]);
  } catch {
    throw new Error('canonical_approval_rejected: invalid json');
  }
  const result = approvalSchema.safeParse(parsed);
  if (!result.success) throw new Error('canonical_approval_rejected: invalid schema');
  return result.data;
}

function validateApprovalRecord(record: ApprovalRecord): void {
  if (record.john_authorization.target_sha !== record.target_sha) {
    throw new Error('canonical_approval_rejected: john target mismatch');
  }
  // Schema types `revoked` as `false | undefined`, but keep the runtime guard
  // as defense-in-depth against records that bypassed schema validation.
  const johnRevoked: boolean = record.john_authorization.revoked ?? false;
  if (johnRevoked) {
    throw new Error('canonical_approval_rejected: john authorization revoked');
  }
  if (record.no_staging_exception && !record.rollback_test_evidence) {
    throw new Error('canonical_approval_rejected: rollback evidence required');
  }

  const principalIds = new Set(record.approvals.map(approval => approval.principal_id));
  const seatIds = new Set(record.approvals.map(approval => approval.seat_id));
  const roles = new Set(record.approvals.map(approval => approval.role));
  if (principalIds.size !== record.approvals.length || seatIds.size !== record.approvals.length) {
    throw new Error('canonical_approval_rejected: duplicate approval');
  }
  if (!roles.has('acting_xo') || !roles.has('second_seat')) {
    throw new Error('canonical_approval_rejected: quorum');
  }
  if (!principalIds.has(record.john_authorization.principal_id)) {
    throw new Error('canonical_approval_rejected: john approval missing');
  }
}
