import { z } from 'zod';
import {
  operatorRequest,
  toolResult,
  type OperatorClientOptions,
  type ToolResult,
} from '../client.js';

export const fireWorkflowInput = {
  name: z.string().min(1),
  conversationId: z.string().min(1),
  message: z.string(),
  approved_by: z.string().min(1),
  approval_reason: z.string().min(1),
  conductor: z.record(z.string(), z.unknown()).optional(),
};

export async function fireWorkflow(
  input: {
    name: string;
    conversationId: string;
    message: string;
    approved_by: string;
    approval_reason: string;
    conductor?: Record<string, unknown>;
  },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  const { name, ...body } = input;
  return toolResult(
    await operatorRequest(
      'fire',
      `/api/workflows/${encodeURIComponent(name)}/run`,
      { method: 'POST', body: JSON.stringify(body) },
      options
    )
  );
}
