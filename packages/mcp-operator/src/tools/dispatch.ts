import { operatorRequest, type OperatorRequestOptions } from './fire';

export function sendMessage(options: OperatorRequestOptions, body: unknown): Promise<unknown> {
  return operatorRequest(options, '/api/dispatch/messages', 'POST', body);
}

function messageAction(
  options: OperatorRequestOptions,
  id: string,
  action: 'claim' | 'result' | 'ack' | 'address' | 'cancel',
  body: unknown
): Promise<unknown> {
  return operatorRequest(
    options,
    `/api/dispatch/messages/${encodeURIComponent(id)}/${action}`,
    'POST',
    body
  );
}

export const claimMessage = (
  options: OperatorRequestOptions,
  id: string,
  body: unknown
): Promise<unknown> => messageAction(options, id, 'claim', body);
export const postResult = (
  options: OperatorRequestOptions,
  id: string,
  body: unknown
): Promise<unknown> => messageAction(options, id, 'result', body);
export const ackMessage = (
  options: OperatorRequestOptions,
  id: string,
  body: unknown
): Promise<unknown> => messageAction(options, id, 'ack', body);
export const addressMessage = (
  options: OperatorRequestOptions,
  id: string,
  body: unknown
): Promise<unknown> => messageAction(options, id, 'address', body);
export const cancelMessage = (
  options: OperatorRequestOptions,
  id: string,
  body: unknown
): Promise<unknown> => messageAction(options, id, 'cancel', body);
