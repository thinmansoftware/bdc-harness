import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
const S = '1'.repeat(40),
  B = '2'.repeat(40);
const proof = {
  principal_token: z.string().optional(),
  holder_id: z.string().min(1),
  holder_token: z.string().min(1),
  fencing_token: z.number().int().positive(),
};
const scopeApprovalRecordBodySchema = z
  .object({
    ...proof,
    repo: z.string().min(1),
    pr_number: z.number().int().positive(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    conditions: z.string().refine(v => v.trim().length > 0),
    evidence_url: z
      .string()
      .url()
      .refine(v => v.startsWith('https://')),
  })
  .strict();
const scopeApprovalRevokeBodySchema = z
  .object({ ...proof, reason: z.string().refine(v => v.trim().length > 0) })
  .strict();
const scopeApprovalPublicReadQuerySchema = z.object({
  repo: z.string(),
  pr_number: z.coerce.number().int().positive(),
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  base_sha: z.string().regex(/^[0-9a-f]{40}$/),
});
const valid = {
  holder_id: 'h',
  holder_token: 't',
  fencing_token: 1,
  repo: 'thinmansoftware/lspro-react',
  pr_number: 626,
  head_sha: S,
  conditions: 'no regression',
  evidence_url: 'https://example.test/e',
};
describe('scope approval route contracts', () => {
  test('record_rejects_forged_body_fields', () => {
    expect(
      scopeApprovalRecordBodySchema.safeParse({ ...valid, authority: 'general' }).success
    ).toBe(false);
    expect(scopeApprovalRecordBodySchema.safeParse({ ...valid, recorded_by: 'john' }).success).toBe(
      false
    );
    expect(scopeApprovalRecordBodySchema.safeParse({ ...valid, conditions: ' ' }).success).toBe(
      false
    );
  });
  test('public_read_needs_exact_valid_query', () => {
    expect(
      scopeApprovalPublicReadQuerySchema.safeParse({
        repo: valid.repo,
        pr_number: '626',
        head_sha: S,
        base_sha: B,
      }).success
    ).toBe(true);
    expect(
      scopeApprovalPublicReadQuerySchema.safeParse({
        repo: valid.repo,
        pr_number: 'x',
        head_sha: 'abc',
        base_sha: B,
      }).success
    ).toBe(false);
  });
  test('revoke_requires_lease_proof_and_reason', () => {
    expect(
      scopeApprovalRevokeBodySchema.safeParse({
        holder_id: 'h',
        holder_token: 't',
        fencing_token: 1,
        reason: 'withdraw',
      }).success
    ).toBe(true);
    expect(
      scopeApprovalRevokeBodySchema.safeParse({
        holder_id: 'h',
        holder_token: 't',
        fencing_token: 1,
        reason: '',
      }).success
    ).toBe(false);
  });
});
