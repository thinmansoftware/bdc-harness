import { describe, expect, test } from 'bun:test';
import { findShadowCollisions } from './check-workflow-shadow-collision';

describe('findShadowCollisions', () => {
  test('returns empty when no root file shares a name with a defaults file', () => {
    expect(findShadowCollisions(['a.yaml', 'b.yaml'], ['c.yaml', 'd.yaml'])).toEqual([]);
  });

  test('flags a filename present in both lists', () => {
    expect(
      findShadowCollisions(
        ['bdc-multi-stage-development.yaml'],
        ['bdc-multi-stage-development.yaml']
      )
    ).toEqual(['bdc-multi-stage-development.yaml']);
  });

  test('flags every colliding filename, sorted', () => {
    expect(
      findShadowCollisions(
        ['z-shadow.yaml', 'a-shadow.yaml', 'unique-root.yaml'],
        ['a-shadow.yaml', 'z-shadow.yaml', 'unique-default.yaml']
      )
    ).toEqual(['a-shadow.yaml', 'z-shadow.yaml']);
  });

  test('empty inputs produce no collisions', () => {
    expect(findShadowCollisions([], [])).toEqual([]);
  });

  test('duplicate entries in the root list do not produce duplicate collisions', () => {
    expect(findShadowCollisions(['dup.yaml', 'dup.yaml'], ['dup.yaml'])).toEqual(['dup.yaml']);
  });
});
