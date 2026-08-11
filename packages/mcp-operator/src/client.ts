export type OperatorScope = 'inspect' | 'message' | 'fire';

export interface OperatorClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  token?: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
}

function tokenForScope(scope: OperatorScope, explicit?: string): string {
  if (explicit) return explicit;
  return process.env[`ARCHON_OPERATOR_TOKEN_${scope.toUpperCase()}`] ?? '';
}

export async function operatorRequest(
  scope: OperatorScope,
  path: string,
  init: RequestInit = {},
  options: OperatorClientOptions = {}
): Promise<unknown> {
  const token = tokenForScope(scope, options.token);
  if (!token) throw new Error(`ARCHON_OPERATOR_TOKEN_${scope.toUpperCase()} is not configured`);
  const baseUrl = (
    options.baseUrl ??
    process.env.ARCHON_API_BASE_URL ??
    'http://localhost:3090'
  ).replace(/\/$/, '');
  const headers = new Headers(init.headers);
  headers.set('x-archon-operator-token', token);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await (options.fetch ?? fetch)(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Preserve a non-JSON upstream response in the surfaced error.
  }
  if (!response.ok) {
    throw new Error(
      `Archon API ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`
    );
  }
  return body;
}

export function toolResult(value: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
