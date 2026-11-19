export interface CompanionSlot {
  companion_id: string;
  enabled: boolean;
  dispatch_principal_id: string;
  token_sha256_file: string;
  token_expires_at: string;
  token_expires_ms: number;
  dispatch_credential_file: string;
  tools: string[];
  allowed_recipients: string[];
  board_secretary: boolean;
  board_seat_recipients: string[];
}

export interface CompanionRegistry {
  slots: CompanionSlot[];
  byPrincipal: ReadonlyMap<string, CompanionSlot>;
}

export interface DispatchWireMessage {
  id: string;
  correlation_id: string;
  sender: string;
  recipient: string;
  body: string;
  status: string;
  task_type: string;
}

export interface DispatchCursorPage {
  messages: DispatchWireMessage[];
  next_after_seq: number;
  page_full: boolean;
}

export interface ProposalFile {
  path: string;
  content: string;
}
