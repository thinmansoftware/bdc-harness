export interface LaneBlockState {
  readonly lane: string;
  readonly reason: string;
  readonly blockedAt: string;
}

const blockedLanes = new Map<string, LaneBlockState>();

export function blockLane(lane: string, reason: string): LaneBlockState {
  const state = { lane, reason, blockedAt: new Date().toISOString() };
  blockedLanes.set(lane, state);
  return state;
}

export function clearLaneBlock(lane: string): boolean {
  return blockedLanes.delete(lane);
}

export function getLaneBlock(lane: string): LaneBlockState | null {
  return blockedLanes.get(lane) ?? null;
}

export function listLaneBlocks(): LaneBlockState[] {
  return [...blockedLanes.values()];
}
