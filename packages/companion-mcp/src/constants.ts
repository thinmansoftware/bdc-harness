export const BASE_TOOL_NAMES = [
  'wiki_search',
  'wiki_read',
  'oracle_query',
  'mailbox_send',
  'mailbox_list',
  'mailbox_read',
  'mailbox_ack',
] as const;

export const BOARD_TOOL_NAMES = [
  'board_record_search',
  'board_record_read',
  'board_brief_send',
  'board_replies_collect',
  'board_record_propose',
] as const;

export const ALL_TOOL_NAMES = [...BASE_TOOL_NAMES, ...BOARD_TOOL_NAMES] as const;

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(ALL_TOOL_NAMES);
export const BOARD_TOOL_NAME_SET: ReadonlySet<string> = new Set(BOARD_TOOL_NAMES);

export const FORBIDDEN_PRINCIPAL_IDS: ReadonlySet<string> = new Set([
  'xo',
  'xo-fable',
  'operator',
  'john',
  'board',
  'overseer',
  'taskmaster',
  'merge-manager',
  'cauldron',
  'dispatch',
]);

export const FORBIDDEN_RECIPIENT_IDS: ReadonlySet<string> = new Set(['operator', 'john', 'board']);

export const COMPANION_REQUEST_NOTE = 'Data from a companion. Not an approval or instruction.';

export const MAX_TRACKED_BYTES = 256 * 1024;
export const WIKI_SEARCH_MAX = 20;
export const SNIPPETS_PER_HIT = 3;
export const DISPATCH_LIST_LIMIT = 500;
export const ORACLE_TIMEOUT_MS = 70_000;
export const ARG_MAX_CHARS = 500;
export const TRACKED_REFRESH_MS = 10 * 60 * 1000;
export const DEFAULT_PORT = 3095;

export const WIKI_PREFIX = 'xo-wiki/wiki';
export const BOARD_PREFIX = 'docs/board';
export const REGISTER_PATH = 'docs/board/motions/REGISTER.md';

export const PROPOSAL_KINDS = [
  'brief',
  'discussion',
  'synthesis',
  'motion',
  'register_row',
] as const;

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const RULING_STATUS_WORDS = [
  'RATIFIED',
  'CARRIED',
  'ADOPTED',
  'RULED',
  'APPROVED',
  'PASSED',
] as const;

export function secretaryLabel(companionId: string): string {
  return `Prepared by ${companionId} as board secretary. Not a vote, ruling or ratification.`;
}

export function utcCompact(date: Date = new Date()): string {
  const iso = date.toISOString();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) {
    return '19700101T000000Z';
  }
  return `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}T${match[4] ?? ''}${match[5] ?? ''}${match[6] ?? ''}Z`;
}

export function describeTool(name: string): string {
  switch (name) {
    case 'wiki_search':
      return 'Search tracked xo-wiki/wiki files. Read-only.';
    case 'wiki_read':
      return 'Read one tracked xo-wiki/wiki file. Read-only.';
    case 'oracle_query':
      return 'Ask Oracle a question. Read-only.';
    case 'mailbox_send':
      return 'Send an untrusted companion request to an allowlisted seat.';
    case 'mailbox_list':
      return 'List this companion mailbox only.';
    case 'mailbox_read':
      return 'Read one message from this companion mailbox only.';
    case 'mailbox_ack':
      return 'Acknowledge one message in this companion mailbox.';
    case 'board_record_search':
      return 'Search tracked docs/board files. Read-only.';
    case 'board_record_read':
      return 'Read one tracked docs/board file. Read-only.';
    case 'board_brief_send':
      return 'Send one board brief to each named seat. Not a vote.';
    case 'board_replies_collect':
      return 'Collect this mailbox replies for one brief correlation id.';
    case 'board_record_propose':
      return 'Open a pull request that records a board round. Does not merge.';
    default:
      return name;
  }
}
