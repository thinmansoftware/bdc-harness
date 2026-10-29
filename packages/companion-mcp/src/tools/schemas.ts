import { z, type ZodType } from 'zod';

import { ALL_TOOL_NAMES, PROPOSAL_KINDS, type ToolName } from '../constants';

export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'array';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
}

const searchSchema: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  },
  required: ['query'],
};

const pathSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
  },
  required: ['path'],
};

const idSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
  },
  required: ['id'],
};

const proposalFileSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['path', 'content'],
};

export const TOOL_INPUT_SCHEMAS: Record<ToolName, JsonSchema> = {
  wiki_search: searchSchema,
  wiki_read: pathSchema,
  oracle_query: {
    type: 'object',
    properties: {
      question: { type: 'string' },
    },
    required: ['question'],
  },
  mailbox_send: {
    type: 'object',
    properties: {
      recipient: { type: 'string' },
      text: { type: 'string' },
      correlation_id: { type: 'string' },
    },
    required: ['recipient', 'text'],
  },
  mailbox_list: {
    type: 'object',
    properties: {
      status: { type: 'string' },
    },
  },
  mailbox_read: idSchema,
  mailbox_ack: idSchema,
  board_record_search: searchSchema,
  board_record_read: pathSchema,
  board_brief_send: {
    type: 'object',
    properties: {
      motion_id: { type: 'string' },
      seats: { type: 'array', items: { type: 'string' } },
      brief_text: { type: 'string' },
    },
    required: ['motion_id', 'seats', 'brief_text'],
  },
  board_replies_collect: {
    type: 'object',
    properties: {
      correlation_id: { type: 'string' },
    },
    required: ['correlation_id'],
  },
  board_record_propose: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: PROPOSAL_KINDS },
      motion_id: { type: 'string' },
      summary: { type: 'string' },
      files: { type: 'array', items: proposalFileSchema },
    },
    required: ['kind', 'motion_id', 'summary', 'files'],
  },
};

const KNOWN_TOOLS: ReadonlySet<string> = new Set(ALL_TOOL_NAMES);
const zodShapes = new Map<ToolName, Record<string, ZodType>>();

function enumSchema(values: readonly string[]): ZodType {
  const first = values[0];
  if (first === undefined) {
    return z.string();
  }
  return z.enum([first, ...values.slice(1)]);
}

function jsonSchemaToZod(schema: JsonSchema): ZodType {
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return enumSchema(schema.enum);
  }
  if (schema.type === 'string') {
    return z.string();
  }
  if (schema.type === 'integer') {
    let numeric = z.number().int();
    if (schema.minimum !== undefined) {
      numeric = numeric.min(schema.minimum);
    }
    if (schema.maximum !== undefined) {
      numeric = numeric.max(schema.maximum);
    }
    return numeric;
  }
  if (schema.type === 'array') {
    return z.array(schema.items === undefined ? z.unknown() : jsonSchemaToZod(schema.items));
  }
  if (schema.type === 'object') {
    return z.object(zodShape(schema));
  }
  return z.unknown();
}

function zodShape(schema: JsonSchema): Record<string, ZodType> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodType> = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const field = jsonSchemaToZod(property);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function isToolName(name: string): name is ToolName {
  return KNOWN_TOOLS.has(name);
}

export function zodInputShape(name: string): Record<string, ZodType> {
  if (!isToolName(name)) {
    throw new Error('unknown_tool_schema');
  }
  const cached = zodShapes.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const shape = zodShape(TOOL_INPUT_SCHEMAS[name]);
  zodShapes.set(name, shape);
  return shape;
}

export function validateToolArguments(name: string, args: unknown): boolean {
  if (!isToolName(name)) {
    return false;
  }
  return z.object(zodInputShape(name)).safeParse(args).success;
}
