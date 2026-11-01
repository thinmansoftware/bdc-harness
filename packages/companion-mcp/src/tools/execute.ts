import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { appendAudit } from '../audit';
import { BOARD_PREFIX, WIKI_PREFIX, WIKI_SEARCH_MAX } from '../constants';
import { DispatchClient } from '../dispatch-client';
import { ToolFailure } from '../errors';
import { scrubDeep } from '../scrub';
import type { TrackedTree } from '../tracked-tree';
import type { CompanionSlot, ProposalFile } from '../types';
import { boardRecordPropose, BOARD_RECORD_PROPOSE_TOOL } from './board';
import {
  boardBriefSend,
  boardRepliesCollect,
  mailboxAck,
  mailboxList,
  mailboxRead,
  mailboxSend,
} from './mailbox';
import { oracleQuery } from './oracle';
import { boardRecordRead, searchTree, wikiRead } from './wiki';

export interface ToolDeps {
  wikiRoot: string;
  tree: TrackedTree;
  oracleUrl: string;
  dispatch: DispatchClient;
  auditLog: string;
  env: Record<string, string | undefined>;
}

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(scrubDeep(payload)) }],
    isError,
  };
}

function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function readLimit(args: Record<string, unknown>): number {
  const value = args.limit;
  if (value === undefined) {
    return WIKI_SEARCH_MAX;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolFailure('refused', 'limit_refused');
  }
  return Math.min(value, WIKI_SEARCH_MAX);
}

function readCursor(args: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(args, 'after_seq')) {
    return 0;
  }
  const value = args.after_seq;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ToolFailure('refused', 'cursor_invalid');
  }
  return value;
}

function readSeats(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const seats: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      return null;
    }
    seats.push(item);
  }
  return seats;
}

function readFiles(value: unknown): ProposalFile[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const files: ProposalFile[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string' || typeof record.content !== 'string') {
      return null;
    }
    files.push({ path: record.path, content: record.content });
  }
  return files;
}

async function runKnownTool(
  slot: CompanionSlot,
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<{ payload: unknown; rowCount: number }> {
  switch (name) {
    case 'wiki_search': {
      const query = readString(args, 'query');
      if (query === null) {
        throw new ToolFailure('refused', 'query_required');
      }
      const hits = await searchTree(deps.wikiRoot, deps.tree, WIKI_PREFIX, query, readLimit(args));
      return { payload: { hits }, rowCount: hits.length };
    }
    case 'wiki_read': {
      const requested = readString(args, 'path');
      if (requested === null) {
        throw new ToolFailure('refused', 'path_refused');
      }
      const page = await wikiRead(deps.wikiRoot, deps.tree, requested);
      return { payload: page, rowCount: 1 };
    }
    case 'oracle_query': {
      const question = readString(args, 'question');
      if (question === null) {
        throw new ToolFailure('refused', 'query_required');
      }
      const answer = await oracleQuery(deps.oracleUrl, slot.companion_id, question);
      return { payload: answer, rowCount: 1 };
    }
    case 'mailbox_send': {
      const recipient = readString(args, 'recipient');
      const text = readString(args, 'text');
      if (recipient === null || text === null) {
        throw new ToolFailure('refused', 'recipient_not_allowed');
      }
      const correlation = readString(args, 'correlation_id') ?? undefined;
      const sent = await mailboxSend(deps.dispatch, slot, recipient, text, correlation);
      return { payload: sent, rowCount: 1 };
    }
    case 'mailbox_list': {
      const status = readString(args, 'status') ?? undefined;
      const page = await mailboxList(deps.dispatch, slot, status, readCursor(args));
      return {
        payload: {
          messages: page.messages,
          next_after_seq: page.next_after_seq,
          page_full: page.page_full,
        },
        rowCount: page.messages.length,
      };
    }
    case 'mailbox_read': {
      const id = readString(args, 'id');
      if (id === null) {
        throw new ToolFailure('refused', 'not_own_message');
      }
      const message = await mailboxRead(deps.dispatch, slot, id);
      return { payload: message, rowCount: 1 };
    }
    case 'mailbox_ack': {
      const id = readString(args, 'id');
      if (id === null) {
        throw new ToolFailure('refused', 'not_own_message');
      }
      const acked = await mailboxAck(deps.dispatch, slot, id);
      return { payload: acked, rowCount: 1 };
    }
    case 'board_record_search': {
      const query = readString(args, 'query');
      if (query === null) {
        throw new ToolFailure('refused', 'query_required');
      }
      const hits = await searchTree(deps.wikiRoot, deps.tree, BOARD_PREFIX, query, readLimit(args));
      return { payload: { hits }, rowCount: hits.length };
    }
    case 'board_record_read': {
      const requested = readString(args, 'path');
      if (requested === null) {
        throw new ToolFailure('refused', 'path_refused');
      }
      const page = await boardRecordRead(deps.wikiRoot, deps.tree, requested);
      return { payload: page, rowCount: 1 };
    }
    case 'board_brief_send': {
      const motionId = readString(args, 'motion_id');
      const briefText = readString(args, 'brief_text');
      const seats = readSeats(args.seats);
      if (motionId === null || briefText === null || seats === null) {
        throw new ToolFailure('refused', 'recipient_not_allowed');
      }
      const sent = await boardBriefSend(deps.dispatch, slot, motionId, seats, briefText);
      return { payload: sent, rowCount: sent.sent };
    }
    case 'board_replies_collect': {
      const correlationId = readString(args, 'correlation_id');
      if (correlationId === null) {
        throw new ToolFailure('refused', 'query_required');
      }
      const replies = await boardRepliesCollect(deps.dispatch, slot, correlationId);
      return { payload: { messages: replies }, rowCount: replies.length };
    }
    case BOARD_RECORD_PROPOSE_TOOL: {
      const kind = readString(args, 'kind');
      const motionId = readString(args, 'motion_id');
      const summary = readString(args, 'summary');
      const files = readFiles(args.files);
      if (kind === null || motionId === null || summary === null || files === null) {
        throw new ToolFailure('refused', 'path_refused');
      }
      const proposed = await boardRecordPropose(
        deps.dispatch,
        slot,
        deps.env,
        kind,
        motionId,
        files,
        summary
      );
      return { payload: proposed, rowCount: 1 };
    }
    default:
      throw new ToolFailure('refused', 'tool_not_allowed');
  }
}

export async function executeTool(
  slot: CompanionSlot,
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<CallToolResult> {
  if (!slot.tools.includes(name)) {
    appendAudit(deps.auditLog, {
      companionId: slot.companion_id,
      tool: name,
      args,
      rowCount: 0,
      outcome: 'refused',
      error: 'tool_not_allowed',
    });
    return textResult({ error: 'tool_not_allowed' }, true);
  }
  try {
    const result = await runKnownTool(slot, name, args, deps);
    appendAudit(deps.auditLog, {
      companionId: slot.companion_id,
      tool: name,
      args,
      rowCount: result.rowCount,
      outcome: 'ok',
    });
    return textResult(result.payload, false);
  } catch (error) {
    if (error instanceof ToolFailure) {
      appendAudit(deps.auditLog, {
        companionId: slot.companion_id,
        tool: name,
        args,
        rowCount: 0,
        outcome: error.outcome,
        error: error.code,
      });
      return textResult({ error: error.code }, true);
    }
    appendAudit(deps.auditLog, {
      companionId: slot.companion_id,
      tool: name,
      args,
      rowCount: 0,
      outcome: 'error',
      error: 'internal_error',
    });
    return textResult({ error: 'internal_error' }, true);
  }
}
