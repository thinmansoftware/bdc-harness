import { z } from 'zod';
import { appendBoardAuditEvent } from '../db/board-authority';
import { freezeCanonicalBoardMotion } from '../workflows/canonical-board-source';

export const boardMotionPayloadSchema = z
  .object({
    motion_id: z.string().regex(/^M-[0-9]+(?:-[0-9]+)*$/),
    title: z.string().min(1),
    file_path: z
      .string()
      .regex(/^docs\/board\/motions\/[^/][A-Za-z0-9._-]*\.md$/)
      .refine(value => !value.includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(value)),
  })
  .strict();

export const boardPetitionPayloadSchema = z
  .object({
    motion_id: z.string().regex(/^M-[0-9]+(?:-[0-9]+)*$/),
    file_path: z
      .string()
      .regex(/^docs\/board\/motions\/[^/][A-Za-z0-9._-]*\.md$/)
      .refine(value => !value.includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(value)),
    requested_action: z.string().min(1).max(500),
  })
  .strict();

export type BoardMotionPayload = z.infer<typeof boardMotionPayloadSchema>;
export type BoardPetitionPayload = z.infer<typeof boardPetitionPayloadSchema>;

export interface ValidatedBoardMotionPointer {
  readonly payload: BoardMotionPayload;
  readonly motion_revision_sha: string;
  readonly commit_sha: string;
}

export async function validateBoardMotionPointer(
  value: unknown,
  dependencies: Parameters<typeof freezeCanonicalBoardMotion>[1] = {}
): Promise<ValidatedBoardMotionPointer> {
  const payload = boardMotionPayloadSchema.parse(value);
  const frozen = await freezeCanonicalBoardMotion(payload.file_path, dependencies);
  if (!/^[0-9a-f]{40}$/.test(frozen.blob_sha)) {
    throw new Error('board_motion_pointer_invalid: blob sha');
  }
  const firstLine = Buffer.from(frozen.bytes).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  const match = /^# (M-[0-9]+(?:-[0-9]+)*): (.+)$/.exec(firstLine);
  if (match?.[1] !== payload.motion_id || match?.[2] !== payload.title) {
    throw new Error('board_motion_pointer_invalid: canonical metadata mismatch');
  }
  return {
    payload,
    motion_revision_sha: frozen.blob_sha,
    commit_sha: frozen.commit_sha,
  };
}

export function deriveBoardMotionNotificationKey(input: {
  readonly motion_id: string;
  readonly motion_revision_sha: string;
  readonly recipient_alias?: 'board';
}): string {
  return `board-motion:${input.motion_id}:${input.motion_revision_sha}:${input.recipient_alias ?? 'board'}`;
}

export async function recordBoardPetitionDelivery(input: {
  readonly actor_principal_id: string;
  readonly actor_seat_id?: string | null;
  readonly body: unknown;
  readonly dispatch_message_id?: string | null;
  readonly dependencies?: Parameters<typeof freezeCanonicalBoardMotion>[1];
}): Promise<BoardPetitionPayload & { motion_revision_sha: string }> {
  const validated = await validateBoardPetitionPointer(input.body, input.dependencies ?? {});
  await appendBoardAuditEvent({
    event_type: 'board_petition_delivered',
    actor_principal_id: input.actor_principal_id,
    actor_seat_id: input.actor_seat_id ?? null,
    motion_id: validated.motion_id,
    motion_revision_sha: validated.motion_revision_sha,
    details: {
      dispatch_message_id: input.dispatch_message_id ?? null,
      file_path: validated.file_path,
      requested_action: validated.requested_action,
    },
  });
  return validated;
}

export async function validateBoardPetitionPointer(
  body: unknown,
  dependencies: Parameters<typeof freezeCanonicalBoardMotion>[1] = {}
): Promise<BoardPetitionPayload & { motion_revision_sha: string }> {
  const payload = boardPetitionPayloadSchema.parse(body);
  const frozen = await freezeCanonicalBoardMotion(payload.file_path, dependencies);
  const firstLine = Buffer.from(frozen.bytes).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
  const match = /^# (M-[0-9]+(?:-[0-9]+)*): /.exec(firstLine);
  if (match?.[1] !== payload.motion_id) {
    throw new Error('board_petition_pointer_invalid: canonical metadata mismatch');
  }
  return { ...payload, motion_revision_sha: frozen.blob_sha };
}
