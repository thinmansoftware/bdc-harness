/**
 * persona-sections.test.ts -- Required output-section enforcement.
 *
 * WO-HARNESS-WAR-COUNCIL-PERSONA-ROSTER-01, spec Test 5:
 * "Given stub reviewer outputs, tests fail if any new persona omits required
 * sections."
 */

import { describe, it, expect } from 'bun:test';
import { PERSONA_REQUIRED_SECTIONS, findMissingSections } from '../persona-sections.js';

/** Build a well-formed stub output containing every required H2 header for a persona. */
function buildCompleteOutput(personaId: string): string {
  const sections = PERSONA_REQUIRED_SECTIONS[personaId];
  if (!sections) throw new Error('unknown persona in test helper: ' + personaId);
  return sections.map(s => '## ' + s + '\n\nStub content for ' + s + '.\n').join('\n');
}

describe('persona required sections -- spec Test 5', () => {
  it('a complete output for every persona reports no missing sections', () => {
    for (const personaId of Object.keys(PERSONA_REQUIRED_SECTIONS)) {
      const complete = buildCompleteOutput(personaId);
      expect(findMissingSections(personaId, complete)).toEqual([]);
    }
  });

  it('detects a single omitted section per persona', () => {
    for (const personaId of Object.keys(PERSONA_REQUIRED_SECTIONS)) {
      const sections = PERSONA_REQUIRED_SECTIONS[personaId]!;
      const omitted = sections[sections.length - 1]!;
      // Build an output missing the last required section.
      const partial = sections
        .slice(0, -1)
        .map(s => '## ' + s + '\n\nStub content.\n')
        .join('\n');
      const missing = findMissingSections(personaId, partial);
      expect(missing).toContain(omitted);
      expect(missing.length).toBe(1);
    }
  });

  it('reports all required sections missing for empty output', () => {
    const personaId = 'security-tenant-pii';
    const missing = findMissingSections(personaId, '');
    expect(missing).toEqual(PERSONA_REQUIRED_SECTIONS[personaId]!);
  });

  it('returns empty array for an unknown persona id (no requirements declared)', () => {
    expect(findMissingSections('not-a-real-persona', 'whatever')).toEqual([]);
  });

  it('each new persona declares exactly six required sections starting with Verdict', () => {
    for (const [personaId, sections] of Object.entries(PERSONA_REQUIRED_SECTIONS)) {
      expect(sections.length).toBe(6);
      expect(sections[0]).toBe('Verdict');
      // guard against accidental duplicate section names
      expect(new Set(sections).size).toBe(sections.length);
      expect(personaId.length).toBeGreaterThan(0);
    }
  });
});
