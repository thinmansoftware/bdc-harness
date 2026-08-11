export interface OperatorRequestOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

export class OperatorApiError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: unknown
  ) {
    super(`Operator API request failed with HTTP ${status}`);
  }
}

export async function operatorRequest(
  options: OperatorRequestOptions,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<unknown> {
  const response = await (options.fetch ?? globalThis.fetch)(`${options.baseUrl}${path}`, {
    method,
    headers: {
      'x-archon-operator-token': options.token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Preserve non-JSON upstream error bodies for the MCP caller.
    }
  }
  if (!response.ok) throw new OperatorApiError(response.status, parsed);
  return parsed;
}

export interface FireWorkflowInput {
  name: string;
  conversationId: string;
  message: string;
  approved_by: string;
  approval_reason: string;
  conductor?: unknown;
}

export function fireWorkflow(
  options: OperatorRequestOptions,
  input: FireWorkflowInput
): Promise<unknown> {
  const { name, ...body } = input;
  return operatorRequest(options, `/api/workflows/${encodeURIComponent(name)}/run`, 'POST', body);
}
