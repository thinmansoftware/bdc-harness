---
motion_id: M-YYYYMMDDx
governs: M-09
repository: owner/name
approved_sha: <40-hex-head-of-the-promoting-PR>
status: TABLED
---

# <Plain-language title -- what deploys, where> (M-YYYYMMDDx)

<!--
THE BLOCK ABOVE IS READ BY A MACHINE (the M-09 promotion gate in bdc-harness,
packages/overseer/src/m09-promotion-gate.ts). Agreed with the harness owner and
ruled by the acting XO on 2026-11-11. It applies to every NEW production motion.
Past motions are not rewritten.

THE BLOCK
 - It is the first thing in the file: a line of three hyphens, the five lines,
   a line of three hyphens. Nothing above it.
 - One field per line, lowercase key at column 0, a colon, ONE token, nothing
   after it. No bold, no quotes, no trailing spaces, ASCII only. Never repeat a key.
 - motion_id: M- plus the date plus one lowercase letter, for example M-20261112a.
 - governs: always the literal M-09.
 - repository: owner/name of the repository the promoting pull request is in.
   Two repositories: one token, comma-separated, no spaces
   (thinmansoftware/shopops,thinmansoftware/lspro-react). A host or container
   change with no promoting pull request: none.
 - approved_sha: the full 40-hex commit that is the HEAD of the promoting pull
   request. Not a short sha, not the merge commit. If that head does not exist
   yet when the Board votes, replace this line with
       approved_tree: <40-hex git tree of the head>     (git rev-parse <head>^{tree})
   Several trees: one token, comma-separated, no spaces. approved_tree is read
   only after the harness owner's parser change lands; until then a motion that
   uses it fails the gate's sha rule. There is no patch_id line.
 - status: one of TABLED, DRAFT, CARRIED, RATIFIED, CARRIED_WITH_CONDITIONS,
   NOT_CARRIED, PARKED, EXECUTED. The gate passes CARRIED and RATIFIED today,
   and CARRIED_WITH_CONDITIONS once the parser change lands (it then prints
   "carried with conditions: read the motion"). Everything else fails, on
   purpose: an EXECUTED motion must not promote a second deploy.
 - Optional, ignored by the gate: johns_go: <UTC time, one token>. John's go is
   never part of status.

FILING RULES (the gate fails the motion if these are not followed)
 1. ONE canonical file per motion, named docs/board/motions/<motion_id>-<slug>.md,
    with a HYPHEN after the id. It carries the block. Every companion file
    (packet, brief, seat replies, votes record, execution record) is named
    <motion_id>.<what>.md, with a DOT after the id. A second hyphen-named file
    for the same id makes two matches and fails.
 2. The motion is MERGED to bdc-xo main, with its final status and the exact
    sha, BEFORE the promoting pull request is opened. The gate reads bdc-xo main
    at the moment it evaluates. If the motion lands later, edit the promoting
    pull request's description to make the gate run again.
 3. Every push to the promoting pull request moves its head. Re-pin both: the
    approved_sha in this file on main, and the block in the pull request body.
 4. The promoting pull request must be up to date with its base (not behind).

OUTSIDE THE BLOCK
 Until the parser change lands the gate scans the whole file. Do not begin any
 line, table row or bullet with the words status, repository, governs,
 motion_id or approved_sha (in any letter case, with or without bold). Write
 "State", "Repo", "Outcome" in prose and tables. Text inside HTML comments and
 fenced code blocks is not scanned.

TITLE RULE (John, 2026-07-16): every motion needs a human-understandable title
leading the header. Put the plain title first and the motion id in parentheses
at the end of the H1, and use the same plain words for the slug in the filename.

NUMBERING: pull origin/main and read docs/board/motions/NEXT_MOTION_NUMBER and
the register before taking an id. Bump the ledger in the same commit that lands
the motion.
-->

**Date:** YYYY-MM-DD
**Mover:** <seat>
**Instrument:** M-09 mechanism -- production deploy

## Block for the promoting pull request

Paste these three lines into the pull request description. In the pull request
they must NOT be inside a code fence or an HTML comment, must have no blank
line between them, no leading spaces, no bold and no trailing spaces, and there
must be exactly one such block in the description.

```
M-09 promotion:
motion_id: M-YYYYMMDDx
approved_sha: <40-hex-head-of-the-promoting-PR>
```

## Why now

<Root cause / trigger, with live-verified evidence. Cite runs, logs, commits.>

## Motion

Deploy <what> to <environment/host/container> at **exact SHA `<commit>`** from
<repo>@<branch>.

## Diff summary (every commit entering production)

- `<sha>` #<PR> <one-line>
<!-- List ALL commits between currently-deployed and target. Bundled unrelated
     PRs are a named risk -- call them out; the second seat will. -->

## Staging evidence

<Exact staging run/canary at the SAME SHA, with numbers. Or a documented
no-staging exception with one line on why staging cannot exist -- exception
deploys get: tested rollback, smallest scope, John pinged before execution.>

## Drain protocol (if the target hosts runs/jobs)

<running+pending to 0 before restart; cite the check command.>

## Rollback

<Prior image/commit retained how; exact restore steps; schema reversibility.>

## What a customer would notice

<Plain English. "Nothing" is acceptable only with a reason.>

## Post-deploy verification (required evidence)

1. <Runtime grep/curl proving the change is IN THE RUNNING artifact (Rule 19).>
2. <Health check.>
3. <Behavioral acceptance test -- the thing that was broken, now observed fixed.>

## Votes

- XO (<model>, acting): <APPROVE/REJECT + one line>
- Second seat (<GPT via codex exec --ignore-user-config | Grok via Cursor>):
  <verdict + recorded adversarial finding, verbatim>
- John Ranson: veto/freeze standing

## Disposition and John's go

<The acting XO's disposition in words, with the binding conditions numbered.
Then John's go, verbatim, with its UTC time and what it answered. When the
disposition is declared, change the last line of the block at the top to the
matching single token and merge that to main before the promoting pull request
opens.>
