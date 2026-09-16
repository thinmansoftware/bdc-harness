# Voice Desk Ops -- Shipping, Receiving, and Packing by Voice

**Date:** 2026-09-16
**Sponsor:** John, 2026-09-16 ("a gpt voice alternative locally ... to help with shipping and receiving and packing")
**Status:** DESIGN. Phase 1 is authored as `bdc-voice-desk-ops` (workflow). Phases 2-3 need their own WOs.
**Rail:** M-129 agent messaging (RATIFIED 2026-08-05), already built in this repo.
**Prior art this supersedes or absorbs:** see S2.

---

## S1. The ask, stated precisely

John's constraints, in his words, from the 2026-09-16 session:

1. "a gpt voice alternative locally maybe running off the laptop"
2. "to help with shipping and receiving and packing"
3. "We have tried voice multiple times but didn't stick -- it has to be as good as gpt voice"
4. "We have the receiving desk now it should work with that"
5. "but interface to all models"
6. "Using m129"

Answers captured the same session: brain may be hybrid or fully local (either acceptable);
v1 gets read plus scoped writes to receiving/packing; hardware is a Windows laptop with an
NVIDIA GPU; deliverable is a WO spec plus workflow YAML.

Constraint 3 is the binding one. Four prior attempts produced working software that John
stopped using. This design treats "didn't stick" as the primary requirement, not a footnote.

---

## S2. Why the four prior attempts didn't stick

This is evidence, not speculation. Each row is from the record.

| Attempt | What it was | Why it died |
|---|---|---|
| Pack-Batch Voice v1/v2/v3 (2026-05-11, three spec revisions) | Telegram bot -> n8n -> Whisper/Piper on .226 -> LSPRO API | **Designed-in latency.** Its own budget: P50 < 5s, P95 < 12s, "fails the WO if P95 > 15s." That is 10-20x slower than GPT voice. A packing bench cannot absorb a 5-second turn. |
| POS Voice Assistant (WO-POS-VOICE-ASSISTANT-WIRING-01) | Porcupine wake word -> Gemini Live -> `/pos/voice/state` SSE | **Narrator, not operator.** `voice-bridge-patch.diff` shows the bridge can only *report* state. There is no tool path back into ShopOps, so it could never *do* desk work. Also stack-superseded (S3). |
| Voice Bridge v0.5 / v0.6 (2026-06-26, commit 7424d2f) | wake word -> local Whisper -> headless `claude -p` -> ElevenLabs | **Not interruptible.** John, 2026-09-07, verbatim: a four-hop turn pipeline that "works but feels like leaving voicemails." |
| Codex desktop voice mode (Phase 0, current) | third-party desktop app | Real conversation, but "crashes often" and ties the voice to someone else's app. |

Two cross-cutting causes:

- **The LLM was in the path of trivial commands.** Every attempt sent "three copies" through a
  model. That is both slow and less accurate than a fixed grammar.
- **Stack churn.** Gemini Live was picked, then superseded; OpenAI Realtime was disqualified;
  ElevenLabs Agents became canonical for DA. Each attempt re-litigated the stack instead of
  making it swappable. Constraint 5 ("interface to all models") is John naming this directly.

---

## S3. Standing rulings this design must not violate

| Ruling | Source | How this design complies |
|---|---|---|
| Voice NEVER crosses a gate -- no deploy, money, external send, or merge. Approvals stay typed. | 2026-06-26 design S10; restated 2026-09-07 rule 4 | S7 gate table. Voice drives the floor loop and stops at the commit. |
| OpenAI Realtime DISQUALIFIED because it locks the brain to GPT. Gemini Flash Live superseded for the same reason. ElevenLabs Agents canonical (Claude-native model dropdown). | `da-grizzly-brain-and-voice` (2026-06-03, LOCKED) | S5. The disqualification is about **the brain**. Splitting mouth from brain dissolves it: the front end is a mouth, the brain stays on the M-129 rail and can be any model. Any front end is then admissible, including Realtime. This is a reconciliation, not an override -- if the board reads it as an override, it needs a board round before Phase 3. |
| System 1 (John's operator interface, local, laptop) is separate from System 2 (Gary, ElevenLabs cloud, customer-facing). | 2026-06-26 design S7 | This is System 1 only. Gary is out of scope. |
| Mode toggle ("hands free" / "keyboard") and on-demand "speak that". | 2026-06-26 design S2 | Kept verbatim in the S6 grammar. |
| DA is the FOC lens on Gary, not its own engine. No parallel scoring brain. | General ruling 2026-07-02, LOCKED | This design adds no scoring or opinion. It is a desk operator. |
| Discrepancy on count always blocks and asks; defer to end-of-batch reconciliation. | Pack-Batch design 2026-05-11 S2/S7 | Kept. That decision was correct; only its transport was wrong. |

Stale doc to patch (already flagged 2026-06-26 S11, still open): the POS voice WO and
`pos-system-design.md` still name "Gemini Flash 2.0 Live." Phase 2 should correct them.

---

## S4. Architecture: two lanes, swappable mouth, brain on the rail

```
  mic (native Windows audio)
    |
    v
  VoiceFrontEnd  -- swappable, full-duplex, barge-in
    |
    +--- lane decision in <10ms (grammar match, no model) ---+
    |                                                        |
    v LANE A: reflex                                         v LANE B: conversation
  DeskToolset (no LLM)                              M-129 rail, subject_key
  POST shopops-api /desk-voice/*                      |
    |                                                 v
    v                                            brain (any model)
  spoken confirmation                                 |
  target P50 < 500ms                                  v
                                                 rail reply -> spoken
```

**Lane A (reflex lane) is the whole point.** A fixed grammar of ~25 desk commands is matched
locally and executed straight against `shopops-api`. No model in the path. Target P50 under
500ms from speech-end to spoken confirmation, and it keeps working with the WAN unplugged.
This is what makes the thing feel instant, and it is the lane that does 95% of receiving-day
work. Warehouse voice-picking practice supports it: a constrained grammar with spoken check
phrases is as accurate as scanning, and materially better than free-form dictation at digits.

**Lane B** is for real questions ("why is this PRH invoice two short?"). It rides the M-129
rail with a `subject_key`, exactly as the 2026-09-07 note designed. Multi-second latency is
fine there because John knows he asked a real question. The "still on it" pattern from that
note applies unchanged.

**The mouth is not the brain.** The front end's system prompt forbids it from answering BDC
questions itself. This is the 2026-09-07 rule 1, and it is what preserves a single source of
judgment while still letting the mouth be any vendor.

### Never dictate identifiers

Hard rule: **UPC / ISBN / tracking numbers come from the scanner or the keyboard, never from
the mouth.** Speech recognition is weakest exactly on long digit strings, and this is the
single largest source of voice data-entry error. Voice handles quantity, condition, exception,
navigation, and confirmation. The scanner handles identity. Every prior attempt that tried to
voice-enter identifiers is why "voice is inaccurate" became folklore here.

---

## S5. "Interface to all models": the front-end provider interface

Mirror the `IAgentProvider` pattern already in `@archon/providers` -- narrow interface, typed
registry, `builtIn` flag, config-selected, mandatory local fallback.

```ts
export interface VoiceFrontEndCapabilities {
  fullDuplex: boolean;        // true barge-in, not VAD-gated half-duplex
  localOnly: boolean;         // functions with no network
  firstAudioMsP50: number;    // MEASURED on m129, not vendor-claimed
}

export interface IVoiceFrontEnd {
  readonly id: string;
  readonly displayName: string;
  readonly builtIn: boolean;
  readonly capabilities: VoiceFrontEndCapabilities;
  start(opts: VoiceSessionOptions): Promise<VoiceSession>;
}

export interface VoiceSession {
  on(event: 'transcript', cb: (t: { text: string; final: boolean }) => void): void;
  on(event: 'bargein',    cb: () => void): void;
  on(event: 'error',      cb: (e: Error) => void): void;
  speak(text: string): Promise<void>;
  interrupt(): Promise<void>;   // must cut audio in <150ms
  close(): Promise<void>;
}
```

Registered providers:

| id | Stack | Role | builtIn |
|---|---|---|---|
| `local-cascade` | Parakeet TDT 0.6B v3 (or the faster-whisper already running on :9000) + Kokoro TTS + local grammar | **The floor.** Offline, free, Lane A only. Mandatory fallback so the desk never hard-fails. | yes |
| `openai-realtime` | `gpt-realtime-2` | Best full-duplex available. Admissible only under the S3 mouth/brain reconciliation. | yes |
| `gemini-live` | Existing `voice-bridge` Gemini Live code | Already written; keep as an option rather than delete. | yes |
| `elevenlabs-agents` | Canonical DA pick, Claude-native dropdown | Claude-brained option; shares the Gary voice asset. | yes |

Two notes on the local stack, both changes from the 2026-06-26 record:

- **Piper is archived** (read-only on GitHub since 2025-10-06). It still runs, but it is not a
  forward choice. `local-cascade` should use **Kokoro** for TTS. The 2026-06-26 line "local
  Piper is the free floor" needs this correction.
- **Parakeet TDT 0.6B v3** now beats Whisper large-v3 on accuracy at a quarter the size and is
  dramatically faster on CPU. For a fixed-grammar reflex lane it is the better pick than
  Whisper. Keep the existing Whisper endpoint as the fallback so nothing has to be ripped out.

### Windows / m129 reality check

Audio I/O must run as a **native Windows process**. WSL2 has no native microphone support --
this is a known, unfixed limitation and it has already bitten voice projects. CUDA in WSL2 is
fine; audio is not. So: native Windows Node process owns the mic and speaker, and if a model
needs to live in WSL2 it receives PCM over a local socket. `scripts/dispatch-worker/` already
ships `install-windows.ps1` and `start-windows.ps1`, so native Windows service install is an
established pattern in this repo and should be reused rather than reinvented.

---

## S6. Command grammar (Lane A, v1)

Spoken at the desk. Every write gets a spoken confirmation containing a **check phrase** --
the operator hears back what was recorded, in the same breath.

| Operator says | Effect | Confirmation |
|---|---|---|
| "start receiving <distributor>" / "open the PRH box" | opens a receiving session | "PRH box open. 42 titles expected." |
| (scanner fires) | records identity, waits for qty | "Batman 150. How many?" |
| "three" / "three copies" / "qty three" | applies qty to last scan | "Batman 150, three, confirmed." |
| "short one" / "short two" | records shortage on current line | "Short one on Batman 150. Flagged." |
| "damaged one" / "extra one" | records condition exception | "One damaged, Batman 150. Flagged." |
| "next" / "what's next" | advances queue | reads next title + expected count |
| "how many left" / "status" | progress read-out | "18 of 42 done, 3 flagged." |
| "note <freeform>" | attaches freeform note to line | "Noted." |
| "repeat" / "say that again" | repeats last utterance | -- |
| "cancel that" / "undo" | reverses the last Lane A write in this session | "Reversed. Batman 150 back to zero." |
| "ready to submit" | reads the summary, then **stops** | "42 titles, 3 flagged. Submit from the screen." |
| "hands free" / "keyboard" | mode toggle (2026-06-26 S2) | "Hands free." |
| "speak that" | on-demand read-aloud (2026-06-26 S2) | -- |
| anything unmatched | falls through to Lane B | "Asking XO." |

Count mismatch always blocks and asks, per the 2026-05-11 decision. Defer-to-end-of-batch
reconciliation is retained, with typed reasons at the end.

---

## S7. What voice may and may not do (the gate table)

John approved "read plus scoped writes to receiving/packing." The standing invariant says
voice never crosses a gate. Both are satisfiable, because the gate lands at the commit:

| Operation | Voice | Reason |
|---|---|---|
| `GET /receiving-sessions/:id` | allowed | read |
| `POST /receiving-sessions` (open) | allowed | internal, reversible via cancel |
| `POST /receiving-sessions/:id/scan` | allowed | additive, reversible pre-submit |
| `POST /receiving-sessions/:id/cancel` | allowed | reverses, no inventory effect |
| `POST /inventory-receipt/sessions/:id/items` | allowed | staged, not committed |
| `GET /inventory-receipt/sessions/:id/summary` | allowed | read |
| `GET /packing/queue`, `GET /packing/metrics` | allowed | read |
| `POST /packing/:id/advance` (QUEUED->PICKED->PACKED) | allowed | internal state; no money, no external send |
| `GET /shipping` | allowed | read |
| `POST /receiving-sessions/:id/submit` | **TYPED ONLY** | writes inventory and allocates pulls; irreversible |
| `POST /inventory-receipt/commit` | **TYPED ONLY** | same |
| `POST /shipping/finalize`, `PATCH /shipping/:id` -> SHIPPED | **FORBIDDEN** | carrier + customer notification = external send |
| anything invoices / billing / Stripe | **FORBIDDEN** | money |

So voice runs the entire floor loop -- open the box, scan, count, flag, pack, advance -- and
stops at the commit. "Ready to submit, three discrepancies" is the end of the voice lane.

### Two safety properties the existing endpoints demand

- **Idempotency.** `POST /shipping/finalize` already requires `idempotency_key`. Every
  voice-originated write must carry one derived from `subject_key` + a hash of the utterance,
  so a re-heard or re-delivered command cannot double-apply. Voice makes duplicate delivery
  far more likely than a UI does; this is not optional.
- **Optimistic concurrency.** `POST /packing/:id/advance` and `PATCH /shipping/:id` require
  `expected_version`. Lane A must read the current version immediately before writing, and
  surface a version conflict as a spoken "someone else moved that one" rather than retrying
  blindly.

---

## S8. M-129 integration

The rail is built in this repo and needs nothing new for Lane B:

- `agent_dispatch_messages` carries `subject_key`, `priority` (`blocker` / `normal` /
  `heartbeat`), `task_outcome`, `acknowledged_at/by`, `addressed_at/by`, `supersedes_id`.
- `packages/core/src/db/dispatch.ts` exposes `createAuthenticatedMessage`,
  `normalizeDispatchSubjectKey`, `assessDispatchRecipient`, `acknowledgeMessage`,
  `addressMessage`, `postResult`, `listMessagesBySeqCursor`, `renewMessageLease`.

Rules for the voice front end on the rail:

1. One `subject_key` per topic; follow-ups reuse it. Use `normalizeDispatchSubjectKey`.
2. Desk questions are `priority: normal`. A blocked receiving session is `blocker`.
3. Read-back is bounded-wait then "still on it," never poll-forever (2026-09-07 rule 3).
4. **The poller heartbeat is a hard dependency, not a nicety.** The 2026-09-05 failure -- three
   messages unread for two hours because the poller died with its process -- becomes audible
   silence in seconds under voice. 2026-09-07 open check 1 is still open. Phase 2 must not ship
   without it.

---

## S9. Phasing

Phase boundaries follow repo ownership, because that is the real constraint.

**Phase 1 -- ShopOps desk-voice tool surface.** `thinmansoftware/shopops`. Authored as
`.archon/workflows/defaults/bdc-voice-desk-ops.yaml`. Adds `shopops-api/routes/desk-voice.js`:
a whitelisted tool surface over the receiving/packing operations in the S7 table, with
idempotency keys, `expected_version` handling, a `desk_voice_log` audit table, and SSE desk
events reusing the `services/voice-events.js` pattern. This is the half that must exist before
any front end can act, and it is the half a harness workflow can reach today.

**Phase 2 -- Voice Bridge front end.** `bluedevilcollectibles/voice-bridge`. `IVoiceFrontEnd`
plus registry, the `local-cascade` provider, the S6 Lane A grammar, the M-129 rail client, the
poller heartbeat, and the native-Windows audio host. Needs its own WO and its own session:
that repo is under a different owner and could not be attached to the 2026-09-16 session.

**Phase 3 -- remaining providers and phone.** `openai-realtime`, `elevenlabs-agents`, SIP.
Phase 3 is also where the S3 mouth/brain reconciliation should be put to the board if anyone
reads it as overriding the Realtime disqualification.

---

## S10. Success criteria, and the kill criterion

Measured on m129, not claimed:

- **Lane A P50 speech-end to spoken confirmation < 500ms; P95 < 900ms.** Compare to the
  2026-05-11 budget of 5s / 12s. This number is the entire difference between this design and
  the last four.
- **Barge-in cuts audio in < 150ms.**
- **Lane A works with the WAN unplugged.**
- Zero ghost writes -- nothing marked received or packed that was not physically handled --
  across three consecutive receiving sessions (retained from 2026-05-11 S16).
- John works a full week's pull list voice-only up to the submit gate.

**Kill criterion.** If Lane A P95 exceeds 1.5s on m129 at the end of Phase 2, stop. Do not
ship it, do not tune it in production, and do not open Phase 3. A fifth voicemail machine is
worse than no voice at all, because it burns the one thing that is actually scarce here --
John's willingness to try voice again. Stating the abort condition before the build is the
main process change from the previous four attempts.

---

## S11. Open questions for John

1. **m129 confirmation.** Read here as motion M-20260805-129 (the agent messaging rail), which
   is ratified and built in this repo. If "m129" meant a *machine* in the fleet (the naming
   would fit G10 / m42 / m157), the rail integration in S8 still stands but the hardware
   section in S5 needs that host's specs.
2. **Brain for Lane B.** Hybrid (local grammar + remote brain) and fully-local were both
   acceptable. This design implements hybrid, because Lane A already gives the offline floor
   and a 4B local model would be a downgrade for Lane B's actual questions. Confirm.
3. **Board round.** The 2026-06-26 design said the hands-free interface "goes through
   war-council / General before build." General has since retired and the board owns
   architecture. Does Phase 1 (a ShopOps API surface, no voice yet) need a board round, or
   only Phase 2?
