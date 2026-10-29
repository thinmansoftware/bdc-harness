import { readFileSync } from 'node:fs';

import {
  BOARD_TOOL_NAME_SET,
  FORBIDDEN_PRINCIPAL_IDS,
  FORBIDDEN_RECIPIENT_IDS,
  KNOWN_TOOL_NAMES,
} from './constants';
import { RegistryError } from './errors';
import type { CompanionRegistry, CompanionSlot } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RegistryError(field);
  }
  return value.trim();
}

function requireBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new RegistryError(field);
  }
  return value;
}

function requireStringList(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new RegistryError(field);
  }
  const items: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new RegistryError(field);
    }
    items.push(item.trim());
  }
  return items;
}

function isPrefixedAddress(value: string): boolean {
  return value.startsWith('system:') || value.startsWith('board:');
}

function assertPrincipalId(value: string): string {
  const canonical = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(canonical)) {
    throw new RegistryError('dispatch_principal_id');
  }
  if (FORBIDDEN_PRINCIPAL_IDS.has(canonical) || isPrefixedAddress(canonical)) {
    throw new RegistryError('dispatch_principal_id');
  }
  return canonical;
}

function assertRecipient(
  value: string,
  field: string,
  slotPrincipals: ReadonlySet<string>
): string {
  const canonical = value.trim().toLowerCase();
  if (
    canonical.length === 0 ||
    isPrefixedAddress(canonical) ||
    FORBIDDEN_RECIPIENT_IDS.has(canonical)
  ) {
    throw new RegistryError(field);
  }
  if (slotPrincipals.has(canonical)) {
    throw new RegistryError(field);
  }
  return canonical;
}

function parseSlot(value: unknown, slotPrincipals: ReadonlySet<string>): CompanionSlot {
  if (!isRecord(value)) {
    throw new RegistryError('slots');
  }
  const companionId = requireString(value, 'companion_id').toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(companionId)) {
    throw new RegistryError('companion_id');
  }
  const tools = requireStringList(value, 'tools');
  const seenTools = new Set<string>();
  for (const tool of tools) {
    if (!KNOWN_TOOL_NAMES.has(tool) || seenTools.has(tool)) {
      throw new RegistryError('tools');
    }
    seenTools.add(tool);
  }
  const boardSecretary = requireBoolean(value, 'board_secretary');
  if (!boardSecretary && tools.some(tool => BOARD_TOOL_NAME_SET.has(tool))) {
    throw new RegistryError('tools');
  }
  const expiresAt = requireString(value, 'token_expires_at');
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) {
    throw new RegistryError('token_expires_at');
  }
  const allowed = requireStringList(value, 'allowed_recipients').map(item =>
    assertRecipient(item, 'allowed_recipients', slotPrincipals)
  );
  const seats = requireStringList(value, 'board_seat_recipients').map(item =>
    assertRecipient(item, 'board_seat_recipients', slotPrincipals)
  );
  return {
    companion_id: companionId,
    enabled: requireBoolean(value, 'enabled'),
    dispatch_principal_id: assertPrincipalId(requireString(value, 'dispatch_principal_id')),
    token_sha256_file: requireString(value, 'token_sha256_file'),
    token_expires_at: expiresAt,
    token_expires_ms: expiresMs,
    dispatch_credential_file: requireString(value, 'dispatch_credential_file'),
    tools,
    allowed_recipients: allowed,
    board_secretary: boardSecretary,
    board_seat_recipients: seats,
  };
}

export function parseCompanionRegistry(raw: unknown): CompanionRegistry {
  if (!isRecord(raw) || !Array.isArray(raw.slots)) {
    throw new RegistryError('slots');
  }
  const principalIds: string[] = [];
  for (const entry of raw.slots) {
    if (!isRecord(entry)) {
      throw new RegistryError('slots');
    }
    principalIds.push(assertPrincipalId(requireString(entry, 'dispatch_principal_id')));
  }
  const slotPrincipals = new Set(principalIds);
  if (slotPrincipals.size !== principalIds.length) {
    throw new RegistryError('dispatch_principal_id');
  }
  const slots = raw.slots.map(entry => parseSlot(entry, slotPrincipals));
  const companionIds = new Set(slots.map(slot => slot.companion_id));
  if (companionIds.size !== slots.length) {
    throw new RegistryError('companion_id');
  }
  return {
    slots,
    byPrincipal: new Map(slots.map(slot => [slot.dispatch_principal_id, slot])),
  };
}

export function loadCompanionRegistry(configPath: string): CompanionRegistry {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new RegistryError('config');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RegistryError('config');
  }
  return parseCompanionRegistry(parsed);
}
