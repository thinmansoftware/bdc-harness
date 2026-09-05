/**
 * wo-evidence.ts -- ONE classifier for "does this pull request count as evidence
 * that WO <id> shipped?"
 *
 * Two consumers previously each had their own WO-id-from-PR-body extractor and
 * both fired on a BARE MENTION of the id:
 *   - Overseer reconcile (./reconcile.ts) closed the WO tracker as wo:done on any
 *     merged PR whose title or body contained the id.
 *   - Smart Cauldron already-satisfied guard
 *     (packages/smart-cauldron/src/already-satisfied.ts) refused to fire a WO when
 *     any open/merged PR contained the id.
 *
 * Anchor (2026-09-02, WO-LSPRO-M157-STREAM-STAYS-OPEN-UI-01 = bdc-xo #1889):
 * reconcile closed #1889 on three merged PRs -- bdc-xo #1898 (the WO's own spec
 * amendment), lspro-react #570 (a different fix) and shopops #662 (the WO this
 * one depends on, which named the id in an Overseer finding reply). None of them
 * implemented the WO; its stop-condition greps were 0 on staging. Four minutes
 * later the conductor refused to fire #1889 because lspro-react #568 (a merged
 * pre-step) mentioned the id. Both sites read a mention as a claim.
 *
 * Rules (shared by both sites):
 *   1. A line `Reconcile-Skip: <WO-ID>[, <WO-ID>...]` (label case-insensitive)
 *      EXCLUDES the PR as evidence/satisfaction for the listed ids. The PR may
 *      still count for other ids it names.
 *   2. Otherwise a PR CLAIMS a WO only when its title starts with the id, its
 *      body carries the manifest label line `WO: <WO-ID>`, or (Cauldron guard
 *      only) its head branch is named after the id.
 *   3. Anything else that contains the id is a MENTION -- never evidence.
 *
 * Pure functions, no I/O. ASCII only.
 */

/** Uppercase WO id as it appears in trackers and specs. Global flag: use with matchAll. */
export const WO_ID_PATTERN = /\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2}\b/g;

/** Same shape, case-insensitive, for reading ids out of free text people typed. */
const WO_ID_TOKEN = /\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)*-[0-9]{2}\b/gi;

/**
 * `Reconcile-Skip: WO-A-01, WO-B-02` on a line of its own. The label is
 * case-insensitive and tolerates spaces around the colon; the value is any
 * comma/space separated list of WO ids. The line must START with the label
 * (leading whitespace allowed) -- prose that merely talks about the marker
 * ("see Reconcile-Skip: ...") does not count.
 */
const RECONCILE_SKIP_LINE = /^[ \t]*reconcile-skip[ \t]*:[ \t]*(.*?)[ \t]*$/gim;

/** Manifest v2 label line: `WO: <WO-ID>` alone on a line (fenced or not). */
const MANIFEST_WO_LINE = /^[ \t]*WO[ \t]*:[ \t]*(\S+)[ \t]*$/gim;

export type WoEvidence = 'excluded' | 'claim' | 'mention' | 'none';

export interface WoEvidenceSource {
  title?: string | null;
  body?: string | null;
  /** Head branch name. Only the Cauldron guard has it; reconcile passes nothing. */
  headRef?: string | null;
}

function isIdChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

/**
 * True when `text` starts with `woId` (case-insensitive) and the id is not the
 * prefix of a longer id: "WO-FOO-01" must not match "WO-FOO-010" or
 * "WO-FOO-01A". A hyphen after the id is a boundary (branch suffixes such as
 * "-thread-abc" are fine).
 */
function startsWithWoId(text: string, woId: string): boolean {
  if (!woId || !text) return false;
  if (!text.toLowerCase().startsWith(woId.toLowerCase())) return false;
  const after = text.charAt(woId.length);
  return after === '' || !isIdChar(after);
}

function tokenIsWoId(token: string, woId: string): boolean {
  return token.toLowerCase() === woId.toLowerCase();
}

/**
 * Every WO id listed on `Reconcile-Skip:` lines in a PR body, upper-cased.
 * Empty set when the body has no such line.
 */
export function extractReconcileSkipStems(body: string | null | undefined): Set<string> {
  const stems = new Set<string>();
  if (!body) return stems;
  for (const line of body.matchAll(RECONCILE_SKIP_LINE)) {
    for (const id of (line[1] ?? '').matchAll(WO_ID_TOKEN)) {
      stems.add(id[0].toUpperCase());
    }
  }
  return stems;
}

/** True when the PR body carries `Reconcile-Skip: ...` naming `woId`. */
export function isReconcileSkipped(body: string | null | undefined, woId: string): boolean {
  return extractReconcileSkipStems(body).has(woId.toUpperCase());
}

/** True when the PR title (trimmed) starts with the WO id. */
export function titleClaimsWoId(title: string | null | undefined, woId: string): boolean {
  return startsWithWoId((title ?? '').trim(), woId);
}

/** True when the PR body has a manifest label line `WO: <woId>`. */
export function manifestClaimsWoId(body: string | null | undefined, woId: string): boolean {
  if (!body) return false;
  for (const line of body.matchAll(MANIFEST_WO_LINE)) {
    if (tokenIsWoId(line[1] ?? '', woId)) return true;
  }
  return false;
}

/**
 * True when the last path segment of the head branch starts with the WO id,
 * e.g. `feat/wo-harness-x-01-thread-9c8ee675` or `wo/WO-HARNESS-X-01`.
 * A branch that merely contains the id later in the segment does not claim it.
 */
export function branchClaimsWoId(headRef: string | null | undefined, woId: string): boolean {
  if (!headRef) return false;
  const segment = headRef.split('/').pop() ?? '';
  return startsWithWoId(segment, woId);
}

/**
 * Loose token match: `woId` appears anywhere in `text` as a whole token
 * (case-insensitive, sibling ids like WO-FOO-010 excluded). This is what both
 * sites used to treat as a claim. It is now only a MENTION.
 */
export function mentionsWoId(text: string | null | undefined, woId: string): boolean {
  if (!woId || !text) return false;
  const hay = text.toLowerCase();
  const needle = woId.toLowerCase();
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : hay.charAt(idx - 1);
    const after = hay.charAt(idx + needle.length);
    if ((before === '' || !isIdChar(before)) && (after === '' || !isIdChar(after))) return true;
    from = idx + 1;
  }
  return false;
}

/**
 * Classify one PR as evidence for one WO id.
 *
 *   excluded -- Reconcile-Skip names this id; never evidence, never satisfaction
 *   claim    -- title starts with the id, manifest `WO:` line, or head branch
 *   mention  -- the id appears somewhere else; NOT evidence
 *   none     -- the id does not appear at all
 */
export function classifyWoEvidence(pr: WoEvidenceSource, woId: string): WoEvidence {
  const body = pr.body ?? '';
  if (isReconcileSkipped(body, woId)) return 'excluded';
  if (
    titleClaimsWoId(pr.title, woId) ||
    manifestClaimsWoId(body, woId) ||
    branchClaimsWoId(pr.headRef, woId)
  ) {
    return 'claim';
  }
  if (mentionsWoId(`${pr.title ?? ''}\n${body}\n${pr.headRef ?? ''}`, woId)) return 'mention';
  return 'none';
}

/** Convenience: true only for a 'claim' (an excluded PR is never a claim). */
export function prClaimsWoId(pr: WoEvidenceSource, woId: string): boolean {
  return classifyWoEvidence(pr, woId) === 'claim';
}
