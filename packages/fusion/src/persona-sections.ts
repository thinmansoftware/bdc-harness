/**
 * persona-sections.ts -- Required output-section enforcement for the new War
 * Council reviewer personas.
 *
 * WO-HARNESS-WAR-COUNCIL-PERSONA-ROSTER-01, spec sections 5.1-5.6.
 *
 * Each new persona must emit a fixed set of H2 section headers. This module
 * declares those required headers per reviewer id and provides a checker that
 * returns the headers a given reviewer output is missing. It is used by the
 * fixture tests (spec Test 5) to fail if a persona output omits a required
 * section.
 *
 * Section headers are matched as "## <Header>" (H2), the same convention the
 * synthesizer output uses in synthesis.ts.
 */

/**
 * PERSONA_REQUIRED_SECTIONS -- reviewer id -> ordered list of required section
 * headers (without the leading "## ").
 */
export const PERSONA_REQUIRED_SECTIONS: Record<string, string[]> = {
  'product-advocate': [
    'Verdict',
    'User Impact',
    'Confusing / Missing UX',
    'Trust Gaps',
    'Required Fixes',
    'Nice-to-Have Later',
  ],
  contrarian: [
    'Verdict',
    'Should This Exist?',
    'Smallest Useful Version',
    'Reasons To Kill / Defer',
    'Scope Cuts',
    'Required Proof Before Build',
  ],
  'prior-art-scout': [
    'Verdict',
    'Files / Docs Searched',
    'Existing Prior Art Found',
    'Extend / Replace / Verify Recommendation',
    'Duplicate / Superseded Work',
    'Open Questions',
  ],
  'buyer-critic': [
    'Verdict',
    'Revenue / Cost / Time Impact',
    'Who Pays Or Benefits',
    'Business Risk',
    'Cheapest Proof',
    'Metrics To Watch',
  ],
  'operator-friction': [
    'Verdict',
    'Operator Burden',
    'What John Sees',
    'Hidden / Buried States',
    'Manual Steps Remaining',
    'Required Legibility Fixes',
  ],
  'security-tenant-pii': [
    'Verdict',
    'Tenant Isolation',
    'PII / Secrets',
    'Entitlements / Billing',
    'Data Mutation Risk',
    'Required Fixes',
  ],
};

/**
 * findMissingSections -- return the required section headers that `text` does not
 * contain (as "## <Header>"), for the given persona id.
 *
 * Returns an empty array when the persona id is unknown (no requirements declared)
 * or when all required sections are present. Callers that need "unknown persona"
 * to be an error should check membership in PERSONA_REQUIRED_SECTIONS first.
 */
export function findMissingSections(personaId: string, text: string): string[] {
  const required = PERSONA_REQUIRED_SECTIONS[personaId];
  if (!required) return [];
  return required.filter(section => !text.includes('## ' + section));
}
