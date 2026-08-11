import { z } from 'zod';
import {
  operatorRequest,
  toolResult,
  type OperatorClientOptions,
  type ToolResult,
} from '../client.js';

export const dispatchBodyInput = { body: z.record(z.string(), z.unknown()) };
export const dispatchMessageInput = {
  id: z.string().min(1),
  body: z.record(z.string(), z.unknown()),
};

async function dispatch(
  path: string,
  body: Record<string, unknown>,
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return toolResult(
    await operatorRequest('message', path, { method: 'POST', body: JSON.stringify(body) }, options)
  );
}

export const sendMessage = (
  input: { body: Record<string, unknown> },
  options?: OperatorClientOptions
): Promise<ToolResult> => dispatch('/api/dispatch/messages', input.body, options);

export function claimMessage(
  input: { id: string; body: Record<string, unknown> },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return dispatch(
    `/api/dispatch/messages/${encodeURIComponent(input.id)}/claim`,
    input.body,
    options
  );
}
export function postResult(
  input: { id: string; body: Record<string, unknown> },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return dispatch(
    `/api/dispatch/messages/${encodeURIComponent(input.id)}/result`,
    input.body,
    options
  );
}
export function ackMessage(
  input: { id: string; body: Record<string, unknown> },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return dispatch(
    `/api/dispatch/messages/${encodeURIComponent(input.id)}/ack`,
    input.body,
    options
  );
}
export function addressMessage(
  input: { id: string; body: Record<string, unknown> },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return dispatch(
    `/api/dispatch/messages/${encodeURIComponent(input.id)}/address`,
    input.body,
    options
  );
}
export function cancelMessage(
  input: { id: string; body: Record<string, unknown> },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return dispatch(
    `/api/dispatch/messages/${encodeURIComponent(input.id)}/cancel`,
    input.body,
    options
  );
}
