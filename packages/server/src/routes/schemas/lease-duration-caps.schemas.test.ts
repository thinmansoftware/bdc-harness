import { describe, expect, test } from 'bun:test';
import { claimDispatchMessageBodySchema, renewDispatchLeaseBodySchema } from './dispatch.schemas';
import {
  acquireExecutionClaimBodySchema,
  renewExecutionClaimBodySchema,
} from './execution-claims.schemas';
import {
  XO_LEASE_MAX_DURATION_MS,
  xoLeaseAcquireBodySchema,
  xoLeaseRenewBodySchema,
} from './board-authority.schemas';

// WO-HARNESS-XO-LEASE-8H-CAP-01: only the XO lease cap moved, to 8 hours. The dispatch and
// execution-claims lease caps stay at one hour.
const ONE_HOUR_MS = 3_600_000;
const EIGHT_HOURS_MS = 28_800_000;

interface HasLeaseDuration {
  readonly shape: {
    readonly lease_duration_ms: { safeParse: (value: unknown) => { success: boolean } };
  };
}

const accepts = (schema: HasLeaseDuration, value: number): boolean =>
  schema.shape.lease_duration_ms.safeParse(value).success;

describe('lease duration caps', () => {
  test('the XO lease cap constant is exactly 8 hours', () => {
    expect(XO_LEASE_MAX_DURATION_MS).toBe(EIGHT_HOURS_MS);
  });

  test.each([
    ['xoLeaseAcquireBodySchema', xoLeaseAcquireBodySchema],
    ['xoLeaseRenewBodySchema', xoLeaseRenewBodySchema],
  ])(
    '%s accepts 8 hours, one hour and one minute, and rejects 8 hours plus 1 ms',
    (_name, schema) => {
      expect(accepts(schema, EIGHT_HOURS_MS)).toBe(true);
      expect(accepts(schema, ONE_HOUR_MS)).toBe(true);
      expect(accepts(schema, 60_000)).toBe(true);
      expect(accepts(schema, EIGHT_HOURS_MS + 1)).toBe(false);
      expect(accepts(schema, 0)).toBe(false);
      expect(accepts(schema, -1)).toBe(false);
    }
  );

  test.each([
    ['claimDispatchMessageBodySchema', claimDispatchMessageBodySchema],
    ['renewDispatchLeaseBodySchema', renewDispatchLeaseBodySchema],
    ['acquireExecutionClaimBodySchema', acquireExecutionClaimBodySchema],
    ['renewExecutionClaimBodySchema', renewExecutionClaimBodySchema],
  ])('%s is still capped at one hour', (_name, schema) => {
    expect(accepts(schema, ONE_HOUR_MS)).toBe(true);
    expect(accepts(schema, ONE_HOUR_MS + 1)).toBe(false);
    expect(accepts(schema, EIGHT_HOURS_MS)).toBe(false);
  });
});
