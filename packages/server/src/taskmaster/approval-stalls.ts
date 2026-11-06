/** Harness-only approval supervision. No prompt approval capability. */
export interface ApprovalState {
  request_id: string;
  thread_id: string;
  command_head: string;
  created_at: string;
  first_seen: string;
  resolved?: boolean;
  nudged?: boolean;
  escalated?: boolean;
}
export interface ApprovalDeps {
  read(): Promise<ApprovalState[]>;
  save(state: ApprovalState): Promise<void>;
  send(recipient: string, body: string, key: string): Promise<string>;
  expect(state: ApprovalState, dispatchId: string): Promise<void>;
  close(requestId: string): Promise<void>;
}
export async function approvalPass(
  messages: unknown[],
  now: Date,
  deps: ApprovalDeps
): Promise<void> {
  const states = new Map((await deps.read()).map(s => [s.request_id, s]));
  const objects = messages.filter(
    (m): m is Record<string, unknown> => !!m && typeof m === 'object'
  );
  const resolved = new Map<string, string>();
  // Dispatch history retains resolutions, including those preceding a breach.
  for (const m of objects) {
    if (
      m.schema !== 't3-approval-resolved/v1' ||
      typeof m.request_id !== 'string' ||
      !m.request_id ||
      typeof m.thread_id !== 'string' ||
      !m.thread_id ||
      typeof m.resolved_at !== 'string' ||
      !Number.isFinite(Date.parse(m.resolved_at))
    )
      continue;
    const prior = states.get(m.request_id);
    if (prior && prior.thread_id !== m.thread_id) continue;
    resolved.set(m.request_id, m.thread_id);
    if (!prior || prior.resolved) continue;
    const state = prior;
    await deps.close(state.request_id);
    state.resolved = true;
    await deps.save(state);
    states.set(state.request_id, state);
  }
  for (const m of objects) {
    if (
      m.schema !== 't3-approval-breach/v1' ||
      m.host !== 'desktop' ||
      m.kind !== 'command' ||
      typeof m.request_id !== 'string' ||
      !m.request_id ||
      typeof m.thread_id !== 'string' ||
      !m.thread_id ||
      typeof m.command_head !== 'string' ||
      m.command_head.length > 140 ||
      typeof m.created_at !== 'string' ||
      !Number.isFinite(Date.parse(m.created_at)) ||
      typeof m.age_min !== 'number' ||
      m.age_min < 15 ||
      now.getTime() - Date.parse(m.created_at) < 15 * 60000
    )
      continue;
    if (resolved.get(m.request_id) === m.thread_id) continue;
    if (!states.has(m.request_id)) {
      const state: ApprovalState = {
        request_id: m.request_id,
        thread_id: m.thread_id,
        command_head: m.command_head,
        created_at: m.created_at,
        first_seen: now.toISOString(),
      };
      await deps.save(state);
      states.set(state.request_id, state);
    }
  }
  for (const state of states.values()) {
    if (state.resolved) continue;
    const key = `tm:pending_approval:${state.request_id}`;
    if (!state.nudged) {
      const id = await deps.send(
        't3-desk-local',
        JSON.stringify({
          schema: 't3-thread-nudge/v1',
          thread_id: state.thread_id,
          text: `Pending approval ${state.request_id}; awaiting authorized operator review.`,
          reason: 'approval-stall',
          request_id: state.request_id,
        }),
        `${key}:nudge`
      );
      await deps.expect(state, id);
      state.nudged = true;
      await deps.save(state);
    }
    if (!state.escalated && now.getTime() - Date.parse(state.first_seen) >= 15 * 60000) {
      const age = Math.floor((now.getTime() - Date.parse(state.created_at)) / 60000);
      await deps.send(
        'duty-officer',
        `pending_approval thread=${state.thread_id} request=${state.request_id} command=${state.command_head} age=${age} min. Authorized operator review required.`,
        `tm:blocker_report:pending_approval:${state.request_id}`
      );
      state.escalated = true;
      await deps.save(state);
    }
  }
}
