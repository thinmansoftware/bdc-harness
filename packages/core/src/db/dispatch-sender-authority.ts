import { createHash, timingSafeEqual } from 'crypto';
import {
  authenticateBoardPrincipal,
  type BoardPrincipal,
  type BoardPrincipalProof,
} from './board-authority';

export type DispatchPrincipalStatus = 'active' | 'retiring' | 'disabled';
export type DispatchPrincipalRole = 'send' | 'receive' | 'admin';
export type DispatchSenderAuthMode = 'off' | 'warn' | 'enforce';

/** Eager registry parse used by HTTP paths so malformed config fails closed in every mode. */
export function assertDispatchPrincipalsRegistryAvailable(
  raw: string | undefined = process.env.DISPATCH_PRINCIPALS_JSON
): void {
  parseDispatchPrincipalsRegistry(raw);
}

export interface DispatchPrincipalCredential {
  readonly credential_id: string;
  readonly principal_id: string;
  readonly status: DispatchPrincipalStatus;
  readonly send_as: readonly string[];
  readonly receive_as: readonly string[];
  readonly roles: readonly DispatchPrincipalRole[];
}

interface CredentialRecord extends DispatchPrincipalCredential {
  readonly token_sha256: string;
}

export type DispatchPrincipalAuthErrorCode =
  | 'dispatch_principal_missing'
  | 'dispatch_principal_partial'
  | 'dispatch_principal_unauthorized'
  | 'dispatch_principal_forbidden'
  | 'dispatch_principal_config_invalid'
  | 'dispatch_sender_auth_mode_invalid'
  | 'dispatch_sender_selector_forbidden';

export class DispatchPrincipalAuthError extends Error {
  readonly code: DispatchPrincipalAuthErrorCode;
  readonly httpStatus: 401 | 403 | 500;

  constructor(code: DispatchPrincipalAuthErrorCode, httpStatus: 401 | 403 | 500, message?: string) {
    super(message ?? code);
    this.name = 'DispatchPrincipalAuthError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type FixedDispatchSystemSender = 'dispatch' | 'overseer' | 'taskmaster';
export type DispatchSystemAuthority = Readonly<{
  kind: 'system';
  sender: FixedDispatchSystemSender;
}>;
export type BoardDispatchPurpose = 'motion_notification' | 'petition';

interface BoundDispatchSender {
  readonly sender: string;
  readonly sender_principal_id: string | null;
}

export interface DispatchHttpCapabilityResult {
  readonly capability: DispatchNonSystemCapability;
  readonly mode: DispatchSenderAuthMode;
  readonly warnLegacy: boolean;
}

const DISPATCH_CAPABILITY_ISSUER = Symbol('dispatch-capability-issuer');
const dispatchCapabilityState = new WeakMap<DispatchNonSystemCapability, BoundDispatchSender>();

/**
 * Runtime-opaque sender provenance accepted by the dispatch DAL.
 *
 * The constructor consumes a module-private key and the bound state lives in a
 * private field. Structural casts and Object.create() forgeries therefore fail
 * at runtime as well as at compile time.
 */
export class DispatchNonSystemCapability {
  readonly #brand = true;

  private constructor(issueKey: symbol, bound: BoundDispatchSender) {
    if (issueKey !== DISPATCH_CAPABILITY_ISSUER) {
      throw new Error('dispatch_sender_capability_invalid');
    }
    if (!this.#brand) throw new Error('dispatch_sender_capability_invalid');
    dispatchCapabilityState.set(this, Object.freeze({ ...bound }));
    Object.freeze(this);
  }

  static fromHttpRequest(input: {
    readonly principal_id?: string | null;
    readonly token?: string | null;
    readonly requested_sender: string;
  }): DispatchHttpCapabilityResult {
    const mode = resolveDispatchSenderAuthMode();
    const hasPrincipal = Boolean(input.principal_id && input.principal_id.length > 0);
    const hasToken = Boolean(input.token && input.token.length > 0);

    if (!hasPrincipal && !hasToken) {
      assertDispatchPrincipalsRegistryAvailable();
      if (mode === 'enforce') {
        throw new DispatchPrincipalAuthError(
          'dispatch_principal_missing',
          401,
          'dispatch_principal_missing'
        );
      }
      return {
        capability: new DispatchNonSystemCapability(DISPATCH_CAPABILITY_ISSUER, {
          sender: canonicalizeLegacySender(input.requested_sender),
          sender_principal_id: null,
        }),
        mode,
        warnLegacy: mode === 'warn',
      };
    }

    const credential = authenticateDispatchPrincipal({
      principal_id: input.principal_id,
      token: input.token,
      requested_sender: input.requested_sender,
      require_send_role: true,
    });
    return {
      capability: new DispatchNonSystemCapability(DISPATCH_CAPABILITY_ISSUER, {
        sender: resolveAuthenticatedSender({
          credential,
          requested_sender: input.requested_sender,
        }),
        sender_principal_id: credential.principal_id,
      }),
      mode,
      warnLegacy: false,
    };
  }

  static fromAuthenticatedRequest(input: {
    readonly principal_id?: string | null;
    readonly token?: string | null;
    readonly requested_sender: string;
  }): DispatchNonSystemCapability {
    // Resolve first so invalid configuration is never hidden by a missing-header
    // response on endpoints that require authenticated provenance in every mode.
    resolveDispatchSenderAuthMode();
    const credential = authenticateDispatchPrincipal({
      principal_id: input.principal_id,
      token: input.token,
      requested_sender: input.requested_sender,
      require_send_role: true,
    });
    return new DispatchNonSystemCapability(DISPATCH_CAPABILITY_ISSUER, {
      sender: resolveAuthenticatedSender({
        credential,
        requested_sender: input.requested_sender,
      }),
      sender_principal_id: credential.principal_id,
    });
  }

  static async fromBoardProof(input: {
    readonly proof: BoardPrincipalProof;
    readonly purpose: BoardDispatchPurpose;
  }): Promise<{ capability: DispatchNonSystemCapability; principal: BoardPrincipal }> {
    const principal = await authenticateBoardPrincipal(input.proof);
    const requiredRole =
      input.purpose === 'motion_notification' ? 'motion_notifier' : 'petition_eligible';
    if (!principal.roles.includes(requiredRole) || principal.seat_id === 'john') {
      throw new Error(
        input.purpose === 'motion_notification'
          ? 'board_motion_notifier_required'
          : 'board_petition_principal_required'
      );
    }
    return {
      capability: new DispatchNonSystemCapability(DISPATCH_CAPABILITY_ISSUER, {
        sender: canonicalizeRequestedSender(principal.principal_id),
        sender_principal_id: `board:${principal.principal_id}`,
      }),
      principal,
    };
  }
}

export type DispatchCreationAuthority = DispatchNonSystemCapability | DispatchSystemAuthority;

export function resolveDispatchSenderCapability(
  capability: DispatchNonSystemCapability
): Readonly<BoundDispatchSender> {
  const bound = dispatchCapabilityState.get(capability);
  if (!bound) throw new Error('dispatch_sender_capability_invalid');
  return bound;
}

const KNOWN_ROLES = new Set<DispatchPrincipalRole>(['send', 'receive', 'admin']);
const RESERVED_PREFIXES = ['system:', 'board:'] as const;
const STABLE_ADDRESS = /^[a-z][a-z0-9_-]*$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PRINCIPAL_ID = /^[a-z][a-z0-9_:-]*$/;

function isDispatchPrincipalStatus(value: unknown): value is DispatchPrincipalStatus {
  return value === 'active' || value === 'retiring' || value === 'disabled';
}

export function resolveDispatchSenderAuthMode(
  raw: string | undefined = process.env.DISPATCH_SENDER_AUTH_MODE
): DispatchSenderAuthMode {
  if (raw === undefined || raw === '') return 'off';
  if (raw === 'off' || raw === 'warn' || raw === 'enforce') return raw;
  throw new DispatchPrincipalAuthError(
    'dispatch_sender_auth_mode_invalid',
    500,
    'dispatch_sender_auth_mode_invalid'
  );
}

export function parseDispatchPrincipalsRegistry(
  raw: string | undefined = process.env.DISPATCH_PRINCIPALS_JSON
): CredentialRecord[] {
  if (raw === undefined || raw === '') {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_config_invalid',
      500,
      'dispatch_principal_config_unavailable'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_config_invalid',
      500,
      'dispatch_principal_config_malformed'
    );
  }
  if (!Array.isArray(parsed)) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_config_invalid',
      500,
      'dispatch_principal_config_malformed'
    );
  }

  const seenCredentialIds = new Set<string>();
  const seenPrincipalDigest = new Set<string>();
  const principalScopes = new Map<string, { send_as: string; receive_as: string; roles: string }>();
  const records: CredentialRecord[] = [];

  for (const value of parsed) {
    if (!value || typeof value !== 'object') {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        'dispatch_principal_config_malformed'
      );
    }
    const record = value as Partial<CredentialRecord>;
    if (
      typeof record.credential_id !== 'string' ||
      record.credential_id.length === 0 ||
      typeof record.principal_id !== 'string' ||
      typeof record.token_sha256 !== 'string' ||
      !DIGEST.test(record.token_sha256) ||
      !isDispatchPrincipalStatus(record.status) ||
      !Array.isArray(record.send_as) ||
      !Array.isArray(record.receive_as) ||
      !Array.isArray(record.roles)
    ) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        'dispatch_principal_config_malformed'
      );
    }

    const status = record.status;
    const principalId = record.principal_id;
    if (
      !PRINCIPAL_ID.test(principalId) ||
      RESERVED_PREFIXES.some(prefix => principalId.startsWith(prefix))
    ) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        'dispatch_principal_config_reserved_or_invalid_principal'
      );
    }

    if (seenCredentialIds.has(record.credential_id)) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        'dispatch_principal_config_duplicate_credential_id'
      );
    }
    seenCredentialIds.add(record.credential_id);

    const principalDigestKey = `${principalId}\0${record.token_sha256}`;
    if (seenPrincipalDigest.has(principalDigestKey)) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        'dispatch_principal_config_duplicate_principal_digest'
      );
    }
    seenPrincipalDigest.add(principalDigestKey);

    const sendAs = canonicalizeAddressList(record.send_as, 'send_as', false);
    const receiveAs = canonicalizeAddressList(record.receive_as, 'receive_as', true);
    const roles = canonicalizeRoles(record.roles);

    const scopeKey = {
      send_as: JSON.stringify(sendAs),
      receive_as: JSON.stringify(receiveAs),
      roles: JSON.stringify(roles),
    };
    const existingScope = principalScopes.get(principalId);
    if (existingScope) {
      if (
        existingScope.send_as !== scopeKey.send_as ||
        existingScope.receive_as !== scopeKey.receive_as ||
        existingScope.roles !== scopeKey.roles
      ) {
        throw new DispatchPrincipalAuthError(
          'dispatch_principal_config_invalid',
          500,
          'dispatch_principal_config_scope_mismatch'
        );
      }
    } else {
      principalScopes.set(principalId, scopeKey);
    }

    records.push({
      credential_id: record.credential_id,
      principal_id: principalId,
      token_sha256: record.token_sha256,
      status,
      send_as: sendAs,
      receive_as: receiveAs,
      roles,
    });
  }

  return records;
}

export function authenticateDispatchPrincipal(input: {
  readonly principal_id?: string | null;
  readonly token?: string | null;
  readonly require_send_role?: boolean;
  readonly requested_sender?: string | null;
  readonly credentialsJson?: string;
}): DispatchPrincipalCredential {
  const principalId = input.principal_id?.trim() ?? '';
  const token = input.token ?? '';
  const hasPrincipal = principalId.length > 0;
  const hasToken = token.length > 0;
  if (!hasPrincipal && !hasToken) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_missing',
      401,
      'dispatch_principal_missing'
    );
  }
  if (hasPrincipal !== hasToken) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_partial',
      401,
      'dispatch_principal_partial'
    );
  }

  const records = parseDispatchPrincipalsRegistry(input.credentialsJson);
  const candidates = records.filter(record => record.principal_id === principalId);
  if (candidates.length === 0) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_unauthorized',
      401,
      'dispatch_principal_unauthorized'
    );
  }

  const presentedDigest = hashToken(token);
  // Examine every credential for the presented principal with timing-safe compares.
  let matchedActiveOrRetiring: CredentialRecord | null = null;
  let matchedDisabled = false;
  for (const candidate of candidates) {
    const digestMatch = hashEquals(presentedDigest, candidate.token_sha256);
    if (!digestMatch) continue;
    if (candidate.status === 'disabled') {
      matchedDisabled = true;
      continue;
    }
    matchedActiveOrRetiring = candidate;
  }
  if (!matchedActiveOrRetiring) {
    if (matchedDisabled) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_unauthorized',
        401,
        'dispatch_principal_disabled'
      );
    }
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_unauthorized',
      401,
      'dispatch_principal_unauthorized'
    );
  }
  const matched = matchedActiveOrRetiring;

  if (input.require_send_role !== false && !matched.roles.includes('send')) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_forbidden',
      403,
      'dispatch_principal_missing_send_role'
    );
  }

  if (input.requested_sender != null && input.requested_sender !== '') {
    const requested = canonicalizeRequestedSender(input.requested_sender);
    if (!matched.send_as.includes(requested)) {
      throw new DispatchPrincipalAuthError(
        'dispatch_sender_selector_forbidden',
        403,
        'dispatch_sender_selector_forbidden'
      );
    }
  }

  return {
    credential_id: matched.credential_id,
    principal_id: matched.principal_id,
    status: matched.status,
    send_as: matched.send_as,
    receive_as: matched.receive_as,
    roles: matched.roles,
  };
}

export function resolveAuthenticatedSender(input: {
  readonly credential: DispatchPrincipalCredential;
  readonly requested_sender?: string | null;
}): string {
  if (input.requested_sender != null && input.requested_sender !== '') {
    const requested = canonicalizeRequestedSender(input.requested_sender);
    if (!input.credential.send_as.includes(requested)) {
      throw new DispatchPrincipalAuthError(
        'dispatch_sender_selector_forbidden',
        403,
        'dispatch_sender_selector_forbidden'
      );
    }
    return requested;
  }
  const primary = input.credential.send_as[0];
  if (!primary) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_forbidden',
      403,
      'dispatch_principal_empty_send_as'
    );
  }
  return primary;
}

function canonicalizeAddressList(values: unknown[], field: string, allowEmpty: boolean): string[] {
  if (values.length === 0) {
    if (allowEmpty) return [];
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_config_invalid',
      500,
      `dispatch_principal_config_empty_${field}`
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        `dispatch_principal_config_invalid_${field}`
      );
    }
    const canonical = requireCanonicalStableAddress(value, field);
    if (seen.has(canonical)) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        `dispatch_principal_config_duplicate_${field}`
      );
    }
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function canonicalizeRoles(values: unknown[]): DispatchPrincipalRole[] {
  if (values.length === 0) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_config_invalid',
      500,
      'dispatch_principal_config_empty_roles'
    );
  }
  const out: DispatchPrincipalRole[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !KNOWN_ROLES.has(value as DispatchPrincipalRole)) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        'dispatch_principal_config_unknown_role'
      );
    }
    if (seen.has(value)) {
      throw new DispatchPrincipalAuthError(
        'dispatch_principal_config_invalid',
        500,
        'dispatch_principal_config_duplicate_role'
      );
    }
    seen.add(value);
    out.push(value as DispatchPrincipalRole);
  }
  return out;
}

/** Registry addresses must already be lowercase canonical form -- never coerce. */
function requireCanonicalStableAddress(value: string, field: string): string {
  if (!STABLE_ADDRESS.test(value)) {
    throw new DispatchPrincipalAuthError(
      'dispatch_principal_config_invalid',
      500,
      `dispatch_principal_config_invalid_${field}`
    );
  }
  return value;
}

/** Request-path sender selectors may arrive mixed-case; normalize then validate. */
function canonicalizeRequestedSender(value: string): string {
  const canonical = value.trim().toLowerCase();
  if (!STABLE_ADDRESS.test(canonical)) {
    throw new DispatchPrincipalAuthError(
      'dispatch_sender_selector_forbidden',
      403,
      'dispatch_sender_selector_forbidden'
    );
  }
  return canonical;
}

function canonicalizeLegacySender(value: string): string {
  const canonical = value.trim().toLowerCase();
  if (canonical.length === 0) {
    throw new DispatchPrincipalAuthError(
      'dispatch_sender_selector_forbidden',
      403,
      'dispatch_sender_selector_forbidden'
    );
  }
  return canonical;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
