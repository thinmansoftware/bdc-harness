import { expect, test } from 'bun:test';
import { blockLane, clearLaneBlock, getLaneBlock } from './lane-block';

test('blocks and clears lanes', () => {
  const state = blockLane('lane-a', 'probe_red');
  expect(getLaneBlock('lane-a')).toEqual(state);
  expect(clearLaneBlock('lane-a')).toBe(true);
  expect(getLaneBlock('lane-a')).toBeNull();
});
