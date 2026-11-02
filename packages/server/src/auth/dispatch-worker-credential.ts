import { createHash, timingSafeEqual } from 'crypto';

export interface DispatchWorkerCredential {
  readonly credential_id: string;
  readonly worker_id: string;
  readonly role: 'board_delivery_worker';
  readonly allowed_principals: readonly string[];
  readonly status: 'active' | 'retiring' | 'disabled';
}

interface CredentialRecord extends DispatchWorkerCredential {
  readonly token_sha256: string;
}

export function authenticateDispatchWorkerCredential(input: {
  readonly credential_id?: string | null;
  readonly token?: string | null;
  readonly worker_id: string;
  readonly delivery_principal?: string | null;
  readonly credentialsJson?: string;
}): DispatchWorkerCredential {
  if (!input.credential_id || !input.token) {
    throw new Error('worker_unauthorized');
  }
  const records = parseCredentialRecords(
    input.credentialsJson ?? process.env.DISPATCH_WORKER_CREDENTIALS_JSON
  );
  const record = records.find(item => item.credential_id === input.credential_id);
  if (!record || record.status === 'disabled') throw new Error('worker_unauthorized');
  if (record.role !== 'board_delivery_worker' || record.worker_id !== input.worker_id) {
    throw new Error('worker_unauthorized');
  }
  if (input.delivery_principal && !record.allowed_principals.includes(input.delivery_principal)) {
    throw new Error('worker_unauthorized');
  }
  if (!hashEquals(hashToken(input.token), record.token_sha256)) {
    throw new Error('worker_unauthorized');
  }
  return {
    credential_id: record.credential_id,
    worker_id: record.worker_id,
    role: record.role,
    allowed_principals: record.allowed_principals,
    status: record.status,
  };
}

function parseCredentialRecords(raw: string | undefined): CredentialRecord[] {
  if (!raw) throw new Error('worker_unauthorized');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('worker_unauthorized');
  }
  if (!Array.isArray(parsed)) throw new Error('worker_unauthorized');
  const seen = new Set<string>();
  return parsed.map(value => {
    if (!value || typeof value !== 'object') throw new Error('worker_unauthorized');
    const record = value as Partial<CredentialRecord>;
    if (
      typeof record.credential_id !== 'string' ||
      typeof record.worker_id !== 'string' ||
      record.role !== 'board_delivery_worker' ||
      !Array.isArray(record.allowed_principals) ||
      record.allowed_principals.length === 0 ||
      typeof record.token_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.token_sha256) ||
      !['active', 'retiring', 'disabled'].includes(String(record.status))
    ) {
      throw new Error('worker_unauthorized');
    }
    if (seen.has(record.credential_id)) throw new Error('worker_unauthorized');
    seen.add(record.credential_id);
    const principals = record.allowed_principals;
    if (
      new Set(principals).size !== principals.length ||
      principals.some(principal => typeof principal !== 'string' || principal.length === 0)
    ) {
      throw new Error('worker_unauthorized');
    }
    return record as CredentialRecord;
  });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
