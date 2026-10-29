import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { CompanionRegistry, CompanionSlot } from './types';

export interface AuthSuccess {
  ok: true;
  slot: CompanionSlot;
}

export interface AuthFailure {
  ok: false;
  status: 401;
  code: string;
  companionId: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestsEqual(leftHex: string, rightHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(leftHex) || !/^[0-9a-f]{64}$/.test(rightHex)) {
    return false;
  }
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readRevokedDigests(revokedFile: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(revokedFile, 'utf8');
  } catch {
    throw new Error('revocation_unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('revocation_unreadable');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('revocation_unreadable');
  }
  const digests = new Set<string>();
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'string') {
      throw new Error('revocation_unreadable');
    }
    digests.add(item.trim().toLowerCase());
  }
  return digests;
}

function readDigestFile(filePath: string): string | null {
  try {
    const text = readFileSync(filePath, 'utf8').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer ([!-~]+)$/.exec(header);
  if (!match?.[1] || header.slice('Bearer '.length) !== match[1]) {
    return null;
  }
  return match[1];
}

export function authenticateRequest(
  authorizationHeader: string | undefined,
  registry: CompanionRegistry,
  revokedFile: string,
  nowMs: number = Date.now()
): AuthResult {
  const token = bearerToken(authorizationHeader);
  if (token === null) {
    return { ok: false, status: 401, code: 'unauthorized', companionId: '' };
  }
  const presented = sha256Hex(token);
  let revoked: Set<string>;
  try {
    revoked = readRevokedDigests(revokedFile);
  } catch {
    return { ok: false, status: 401, code: 'revocation_unreadable', companionId: '' };
  }
  let matched: CompanionSlot | null = null;
  for (const slot of registry.slots) {
    const expected = readDigestFile(slot.token_sha256_file);
    if (expected !== null && digestsEqual(presented, expected)) {
      matched = slot;
      break;
    }
  }
  if (matched === null) {
    return { ok: false, status: 401, code: 'unauthorized', companionId: '' };
  }
  if (!matched.enabled) {
    return { ok: false, status: 401, code: 'slot_disabled', companionId: matched.companion_id };
  }
  if (nowMs > matched.token_expires_ms) {
    return { ok: false, status: 401, code: 'token_expired', companionId: matched.companion_id };
  }
  if (revoked.has(presented)) {
    return { ok: false, status: 401, code: 'token_revoked', companionId: matched.companion_id };
  }
  return { ok: true, slot: matched };
}
