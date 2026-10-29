import { randomUUID } from 'node:crypto';

import { utcCompact } from '../constants';
import { DispatchClient } from '../dispatch-client';
import { ToolFailure } from '../errors';
import type { CompanionSlot, DispatchWireMessage } from '../types';

export async function mailboxSend(
  dispatch: DispatchClient,
  slot: CompanionSlot,
  recipient: string,
  text: string,
  correlationId: string | undefined
): Promise<{ correlation_id: string }> {
  if (text.trim() === '') {
    throw new ToolFailure('refused', 'text_required');
  }
  const canonical = recipient.trim().toLowerCase();
  if (!slot.allowed_recipients.includes(canonical)) {
    throw new ToolFailure('refused', 'recipient_not_allowed');
  }
  const correlation =
    correlationId !== undefined && correlationId.trim() !== ''
      ? correlationId.trim()
      : `companion-${slot.companion_id}-${randomUUID()}`;
  await dispatch.send(slot, {
    recipient: canonical,
    text,
    correlationId: correlation,
  });
  return { correlation_id: correlation };
}

export async function mailboxList(
  dispatch: DispatchClient,
  slot: CompanionSlot,
  status: string | undefined
): Promise<DispatchWireMessage[]> {
  return dispatch.list(slot, status);
}

export async function mailboxRead(
  dispatch: DispatchClient,
  slot: CompanionSlot,
  id: string
): Promise<DispatchWireMessage> {
  const messages = await dispatch.list(slot);
  const found = messages.find(
    message => message.id === id && message.recipient === slot.dispatch_principal_id
  );
  if (found === undefined) {
    throw new ToolFailure('refused', 'not_own_message');
  }
  return found;
}

export async function mailboxAck(
  dispatch: DispatchClient,
  slot: CompanionSlot,
  id: string
): Promise<{ id: string }> {
  await dispatch.ack(slot, id);
  return { id };
}

export async function boardBriefSend(
  dispatch: DispatchClient,
  slot: CompanionSlot,
  motionId: string,
  seats: string[],
  briefText: string
): Promise<{ correlation_id: string; sent: number }> {
  if (!/^M-[A-Za-z0-9][A-Za-z0-9-]*$/.test(motionId)) {
    throw new ToolFailure('refused', 'path_refused');
  }
  if (briefText.trim() === '' || seats.length === 0) {
    throw new ToolFailure('refused', 'recipient_not_allowed');
  }
  const canonicalSeats: string[] = [];
  const seen = new Set<string>();
  for (const seat of seats) {
    const canonical = seat.trim().toLowerCase();
    if (
      canonical.length === 0 ||
      seen.has(canonical) ||
      !slot.board_seat_recipients.includes(canonical)
    ) {
      throw new ToolFailure('refused', 'recipient_not_allowed');
    }
    seen.add(canonical);
    canonicalSeats.push(canonical);
  }
  const correlationId = `board-brief-${motionId}-${utcCompact()}`;
  for (const seat of canonicalSeats) {
    await dispatch.send(slot, {
      recipient: seat,
      text: `Board brief ${motionId}: ${briefText}`,
      correlationId,
    });
  }
  return { correlation_id: correlationId, sent: canonicalSeats.length };
}

export async function boardRepliesCollect(
  dispatch: DispatchClient,
  slot: CompanionSlot,
  correlationId: string
): Promise<DispatchWireMessage[]> {
  if (correlationId.trim() === '') {
    throw new ToolFailure('refused', 'query_required');
  }
  const messages = await dispatch.list(slot);
  return messages.filter(
    message =>
      message.recipient === slot.dispatch_principal_id && message.correlation_id === correlationId
  );
}
