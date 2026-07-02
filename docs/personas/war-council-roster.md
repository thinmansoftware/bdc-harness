# War Council Persona Roster

WO-HARNESS-WAR-COUNCIL-PERSONA-ROSTER-01

## Doctrine statement

> War Council is not just "more reviewers." It is a council of distinct
> failure-mode personas. Each seat exists because a different class of defect
> repeatedly escapes ordinary review: bad architecture, missing prior art, poor
> user legibility, operator friction, weak commercial value, security/tenant
> risk, and premature scope.

The goal is **not** "more reviewers for every WO." The goal is **the right
reviewers for the failure mode.**

## Where each seat lives

Two review mechanisms exist in this repo:

1. **Main Cauldron DAG** (`.archon/workflows/defaults/bdc-feature-development*.yaml`)
   -- reviewer identity is **hardcoded per node**. Personas here:
   `war-council-architect`, `codex-adversarial-reviewer`,
   `claude-doctrine-reviewer`, `captain-ci-validator`, `major-build`.
2. **Cauldron Fusion** (`packages/fusion/`) -- a **config-driven** advisory
   review runner. Reviewer identity is **data** (`fusion.config.json`), which
   makes it the correct extension point for a persona roster + routing matrix.

This WO extends **Fusion only**. The main hardcoded DAG is not modified. The
seats formalized here run as Fusion Round-1 reviewers; the Synthesizer is
Fusion's always-on Round-3 step.

Two seats named in the Mode Matrix are satisfied **outside Fusion** and are NOT
duplicated inside it:

- **Doctrine Reviewer** -- `.archon/agents/claude-doctrine-reviewer.md` (main DAG).
- **CI Validator** -- `.archon/agents/captain-ci-validator.md` (Captain CI).

These are listed in the matrix for completeness but resolve to no Fusion
reviewer id (`SYMBOLIC_ONLY_LABELS` in `packages/fusion/src/routing.ts`).

## The roster

| Seat | Class of defect caught | Runs in |
| --- | --- | --- |
| Architect | design/spec integrity | Fusion (`architect`) + main DAG |
| Adversarial Reviewer | fabricated schema, invented functions, bad patches, risk | Fusion (`systems`) + main DAG |
| Doctrine Reviewer | governance / doctrine drift | main DAG only (symbolic in Fusion) |
| Product/User Advocate | UX legibility, trust, override paths | Fusion (`product-advocate`) |
| Contrarian / Kill-Switch Critic | overbuild, duplicate systems, wrong problem | Fusion (`contrarian`) |
| Prior-Art Scout | re-invention, superseded work, extend-vs-replace | Fusion (`prior-art-scout`) |
| Buyer / Money Critic | revenue/cost/John-minute value | Fusion (`buyer-critic`) |
| Operator Friction Critic | buried approvals, black-box automation, legibility | Fusion (`operator-friction`) |
| Security / Tenant / PII Critic | tenant leakage, secrets, PII, unsafe mutation | Fusion (`security-tenant-pii`) |
| CI Validator | machine-verifiable evidence | Captain CI (symbolic in Fusion) |
| Synthesizer / Judge | turns reviews into one ruling | Fusion Round-3 (always on) |

## Persona label -> Fusion reviewer id

The Mode Matrix uses human-readable labels. `routing.ts` resolves them to
concrete reviewer ids via the `personaMapping` block in
`fusion.config.json`. This makes the mapping an **explicit operator commit**
rather than a code assumption: reviewing `fusion.config.json` is reviewing
the routing choice.

`routing.ts` also exports a code-level fallback
(`DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID`, aliased as the deprecated
`PERSONA_LABEL_TO_REVIEWER_ID` for backward-compatible test imports). The
fallback is only used by callers that do not pass a mapping (unit tests
exercising `selectReviewers` directly). Production CLI runs always load the
config's `personaMapping`.

Current committed mapping (from `packages/fusion/fusion.config.json`):

| Mode Matrix label | Fusion reviewer id |
| --- | --- |
| Architect | `architect` |
| Adversarial Reviewer | `systems` |
| Product/User Advocate | `product-advocate` |
| Contrarian / Kill-Switch Critic | `contrarian` |
| Prior-Art Scout | `prior-art-scout` |
| Buyer / Money Critic | `buyer-critic` |
| Operator Friction Critic | `operator-friction` |
| Security/Tenant/PII Critic | `security-tenant-pii` |
| Doctrine Reviewer | (null -- main DAG) |
| CI Validator | (null -- Captain CI) |
| Synthesizer | (null -- Fusion Round-3, always on) |

To change any of these mappings (including remapping "Adversarial Reviewer"
onto a persona other than `systems`), edit `personaMapping` in
`fusion.config.json`. No code change is required.

## Spec section names -> actual synthesis headers

Spec section 5.7 names some Synthesizer sections differently than the shipped
`REQUIRED_SECTIONS` in `packages/fusion/src/synthesis.ts`. **No rename is being
made**; the concepts are the same. Mapping for reviewers reading both:

| Spec 5.7 name | Actual header in synthesis.ts |
| --- | --- |
| Disagreements Between Reviewers | `## Disagreements` |
| Blocking Findings | `## Must Fix Before Merge` |
| Non-Blocking Findings | `## Nice To Have Later` |
| Required Builder Prompt | `## Suggested Builder Prompt` |
| Final Ruling | `## Final Ruling` |
| Highest Risk | `## Highest Risk` |
| John Approval Question | `## John Approval Question` |

Allowed final rulings (unchanged, already enforced): `APPROVE`,
`APPROVE WITH PATCH`, `HOLD`, `REJECT`.

## Mode matrix (spec section 8)

Encoded in `packages/fusion/src/routing.ts` as `MODE_MATRIX`. Use `--wo-type`
on the Fusion CLI to select a persona set; omitting it runs the full configured
roster (unchanged behavior).

| WO Type (`--wo-type`) | Required personas | Optional |
| --- | --- | --- |
| `architecture-doctrine` | Architect, Contrarian, Prior-Art Scout, Synthesizer | Buyer Critic |
| `harness-automation` | Architect, Operator Friction, Adversarial, Prior-Art Scout, Synthesizer | Security Critic |
| `ux-app-feature` | Architect, Product/User Advocate, Buyer Critic, Adversarial, Synthesizer | Security Critic |
| `revenue-pricing-entitlement` | Architect, Buyer Critic, Security/Tenant, Contrarian, Synthesizer | Doctrine Reviewer |
| `data-billing-inventory` | Architect, Security/Tenant, Adversarial, Doctrine Reviewer, Synthesizer | Operator Friction |
| `small-mechanical-bugfix` | Adversarial, CI Validator | Synthesizer |
| `documentation-only` | Doctrine Reviewer, Prior-Art Scout | Synthesizer |
| `emergency-repair` | Adversarial, Synthesizer | Operator Friction, Security/Tenant |
| `emergency-repair-data` | Adversarial, Security/Tenant, Synthesizer | Operator Friction |

**Routing rule:** if a WO touches more than one category, use the stricter
reviewer set.

**v1 notes:**

- "Optional" personas are documentation-only in v1; the runner selects the
  required set. Optional seats are not auto-added.
- The Synthesizer (Round 3) always runs after Round 1 regardless of `--wo-type`;
  the "optional Synthesizer" annotation is informational only.
- Symbolic-only required labels (Doctrine Reviewer, CI Validator) resolve to no
  Fusion reviewer, so a WO type whose only Fusion-resolvable required persona is,
  e.g., `systems` (small-mechanical-bugfix) intentionally runs a minimal panel --
  this is the "do not over-review tiny patches" behavior.

## Guardrails (unchanged by this WO)

- **Advisory only.** Fusion writes local files and prints to stdout. It does not
  merge, deploy, approve PRs, comment on GitHub, or edit repos. No reviewer
  persona can approve deploy.
- **Builder is not its own reviewer.** `assertReviewerDiversity()` fails closed
  when a selection collapses to a single shared model (v1 proxy for the spec's
  builder-vs-reviewer self-review check; full builder-model tracking is a
  candidate follow-up WO).
- **Synthesizer must not suppress dissent.** The `## Disagreements` section is
  required and preserved; missing reviewers force a conservative ruling.
- **Safety outranks value.** The Security/Tenant/PII Critic is blocking-capable;
  Buyer Critic and other seats may not override a real safety finding.

## Design decisions -- resolved in this WO

The three assumptions the earlier draft flagged for General/John sign-off have
been resolved without waiting for sign-off, by putting the choice in the
operator's hands or by aligning strictly with the spec:

1. **"Adversarial Reviewer" -> `systems` is now an explicit operator commit.**
   The persona label -> reviewer id mapping lives in the `personaMapping` block
   of `fusion.config.json`. The current mapping keeps `Adversarial Reviewer` on
   `systems`, but that is a config choice reviewers can see and change, not a
   hardcoded code assumption. `routing.ts` still exports
   `DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID` as a fallback for unit tests only.

2. **Self-review guard now supports builder-model awareness.**
   `assertReviewerDiversity(reviewers, builderModelId?)` takes an optional
   builder model. When supplied, ANY reviewer whose modelId matches the builder
   fails closed -- including single-reviewer selections such as
   `small-mechanical-bugfix -> systems`. The Fusion CLI accepts
   `--builder-model <modelId>` to thread this through. When the builder model
   is unknown, the guard falls back to the diversity-only proxy (a selection
   collapsing to one shared model still fails).

3. **`emergency-repair` split into two WO types matches spec section 8 literally.**
   `emergency-repair` (base) does NOT require Security/Tenant/PII. The new
   `emergency-repair-data` variant requires it. This encodes the spec's
   "if data/billing is involved" conditional as a type choice the caller must
   make explicitly; there is no silent stricter-when-in-doubt override.
