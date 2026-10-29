import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { COMPANION_REQUEST_NOTE, DISPATCH_LIST_LIMIT } from './constants';
import { ToolFailure } from './errors';
import type { CompanionSlot, DispatchWireMessage } from './types';

export interface CompanionSendInput {
  recipient: string;
  text: string;
  correlationId: string;
  idempotencyKey?: string;
}

function baseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMessage(value: unknown): DispatchWireMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  const correlation = value.correlation_id;
  const sender = value.sender;
  const recipient = value.recipient;
  const body = value.body;
  const status = value.status;
  const taskType = value.task_type;
  if (
    typeof id !== 'string' ||
    typeof correlation !== 'string' ||
    typeof sender !== 'string' ||
    typeof recipient !== 'string' ||
    typeof body !== 'string' ||
    typeof status !== 'string' ||
    typeof taskType !== 'string'
  ) {
    return null;
  }
  return {
    id,
    correlation_id: correlation,
    sender,
    recipient,
    body,
    status,
    task_type: taskType,
  };
}

export class DispatchClient {
  constructor(private readonly dispatchBaseUrl: string) {}

  async send(slot: CompanionSlot, input: CompanionSendInput): Promise<void> {
    const token = await this.readCredential(slot);
    const response = await this.post('/api/dispatch/messages', slot, token, {
      correlation_id: input.correlationId,
      idempotency_key: input.idempotencyKey ?? randomUUID(),
      task_type: 'agent_message',
      sender: slot.dispatch_principal_id,
      recipient: input.recipient,
      body: JSON.stringify({
        kind: 'companion_request',
        from_companion: slot.companion_id,
        untrusted: true,
        note: COMPANION_REQUEST_NOTE,
        text: input.text,
      }),
    });
    if (!response.ok) {
      throw new ToolFailure('error', 'dispatch_rejected');
    }
  }

  async list(slot: CompanionSlot, status?: string): Promise<DispatchWireMessage[]> {
    const token = await this.readCredential(slot);
    const url = new URL(`${baseUrl(this.dispatchBaseUrl)}/api/dispatch/messages`);
    url.searchParams.set('recipient', slot.dispatch_principal_id);
    url.searchParams.set('limit', String(DISPATCH_LIST_LIMIT));
    if (status !== undefined && status.length > 0) {
      url.searchParams.set('status', status);
    }
    let response: Response;
    try {
      response = await fetch(url, { headers: this.headers(slot, token) });
    } catch {
      throw new ToolFailure('error', 'dispatch_unavailable');
    }
    if (!response.ok) {
      throw new ToolFailure('error', 'dispatch_rejected');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ToolFailure('error', 'dispatch_rejected');
    }
    if (!Array.isArray(payload)) {
      throw new ToolFailure('error', 'dispatch_rejected');
    }
    const messages: DispatchWireMessage[] = [];
    for (const item of payload) {
      const message = readMessage(item);
      if (message !== null && message.recipient === slot.dispatch_principal_id) {
        messages.push(message);
      }
    }
    return messages;
  }

  async ack(slot: CompanionSlot, id: string): Promise<void> {
    const token = await this.readCredential(slot);
    const response = await this.post(
      `/api/dispatch/messages/${encodeURIComponent(id)}/ack`,
      slot,
      token,
      { principal_id: slot.dispatch_principal_id }
    );
    if (!response.ok) {
      throw new ToolFailure('error', 'dispatch_rejected');
    }
  }

  private headers(slot: CompanionSlot, token: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-dispatch-principal-id': slot.dispatch_principal_id,
      'x-dispatch-principal-token': token,
    };
  }

  private async readCredential(slot: CompanionSlot): Promise<string> {
    try {
      const value = (await readFile(slot.dispatch_credential_file, 'utf8')).trim();
      if (value.length === 0) {
        throw new Error('empty');
      }
      return value;
    } catch (error) {
      if (error instanceof ToolFailure) {
        throw error;
      }
      throw new ToolFailure('error', 'dispatch_credential_unavailable');
    }
  }

  private async post(
    path: string,
    slot: CompanionSlot,
    token: string,
    body: Record<string, unknown>
  ): Promise<Response> {
    try {
      return await fetch(`${baseUrl(this.dispatchBaseUrl)}${path}`, {
        method: 'POST',
        headers: this.headers(slot, token),
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof ToolFailure) {
        throw error;
      }
      throw new ToolFailure('error', 'dispatch_unavailable');
    }
  }
}
