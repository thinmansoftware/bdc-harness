export interface BoardMotionPromptPayload {
  readonly motion_id: string;
  readonly title: string;
  readonly file_path: string;
}

export function renderBoardMotionPrompt(body: string): string {
  const parsed = JSON.parse(body) as Partial<BoardMotionPromptPayload>;
  if (
    typeof parsed.motion_id !== 'string' ||
    typeof parsed.title !== 'string' ||
    typeof parsed.file_path !== 'string'
  ) {
    throw new Error('board_motion_payload_invalid');
  }
  return [
    `Board motion notification: ${parsed.motion_id}`,
    `Title: ${parsed.title}`,
    `Canonical file: ${parsed.file_path}`,
    '',
    'Review the canonical motion pointer. Do not treat this notification as approval or execution authority.',
  ].join('\n');
}

export function isBoardAliasMessage(message: {
  recipient: string;
  recipient_alias?: string | null;
}): boolean {
  return message.recipient === 'board' || message.recipient_alias === 'board';
}
