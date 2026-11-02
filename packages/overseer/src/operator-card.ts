import { createHash } from 'crypto';

export const OPERATOR_CARD_IDENTITY_VERSION = 'overseer-actionable-event-v1' as const;

export interface ActionableEventIdentity {
  identity_version: typeof OPERATOR_CARD_IDENTITY_VERSION;
  source_event_id: string;
  run_id: string;
  wo_id: string;
  event_type: string;
  step_name: string;
  event_created_at: string;
  error_class: string;
}

export interface OperatorCardPayload {
  repository: string;
  branch: string | null;
  pr_url: string | null;
  pr_number: number | null;
  head_sha: string | null;
  base_branch: string | null;
  base_sha: string | null;
  checks: Record<string, unknown>;
  mergeability: string;
  blocker: string;
  mechanical_evidence: Record<string, unknown>;
  recovery_attempted: Record<string, unknown>;
  proposed_remediation: Record<string, unknown>;
  next_permitted_action: string;
  responsible_actor: string;
  actionable_event_at: string;
  required_ruling: string | null;
  evidence_links: Record<string, unknown>;
  lifecycle_classification: string;
  governance_classification: string;
}

export interface OperatorCard {
  card_id: string;
  identity_version: typeof OPERATOR_CARD_IDENTITY_VERSION;
  canonical_event_identity: ActionableEventIdentity;
  payload_digest: string;
  payload: OperatorCardPayload;
}

function requireText(field: string, value: string): string {
  if (value.trim().length === 0) throw new Error(`operator_card_identity_invalid:${field}`);
  return value;
}

function requireTimestamp(field: string, value: string): string {
  requireText(field, value);
  if (Number.isNaN(Date.parse(value))) throw new Error(`operator_card_identity_invalid:${field}`);
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateIdentity(identity: ActionableEventIdentity): ActionableEventIdentity {
  if (identity.identity_version !== OPERATOR_CARD_IDENTITY_VERSION) {
    throw new Error('operator_card_identity_invalid:identity_version');
  }
  return {
    identity_version: identity.identity_version,
    source_event_id: requireText('source_event_id', identity.source_event_id),
    run_id: requireText('run_id', identity.run_id),
    wo_id: requireText('wo_id', identity.wo_id),
    event_type: requireText('event_type', identity.event_type),
    step_name: requireText('step_name', identity.step_name),
    event_created_at: requireTimestamp('event_created_at', identity.event_created_at),
    error_class: requireText('error_class', identity.error_class),
  };
}

export function canonicalizeActionableEvent(identity: ActionableEventIdentity): string {
  return JSON.stringify(validateIdentity(identity));
}

export function deriveOperatorCardId(identity: ActionableEventIdentity): string {
  return sha256(canonicalizeActionableEvent(identity));
}

export function buildOperatorCard(
  identity: ActionableEventIdentity,
  payload: OperatorCardPayload
): OperatorCard {
  const canonicalIdentity = validateIdentity(identity);
  const normalizedPayload = JSON.parse(canonicalJson(payload)) as OperatorCardPayload;
  return {
    card_id: deriveOperatorCardId(canonicalIdentity),
    identity_version: OPERATOR_CARD_IDENTITY_VERSION,
    canonical_event_identity: canonicalIdentity,
    payload_digest: sha256(canonicalJson(normalizedPayload)),
    payload: normalizedPayload,
  };
}
