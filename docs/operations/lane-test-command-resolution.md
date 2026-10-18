# Lane test-command resolution

Tracking: bdc-xo #2045, WO-HARNESS-LANE-TOOLCHAIN-AND-TEST-COMMAND-01.

All 13 active feature-development lanes resolve a command before
`run-stop-tests`. Resolver and runner mechanics remain identical across
model variants, preserving the existing Astra/Codex DAG parity contract.
The resolver reads the fixed `scripts/cauldron/cauldron-projects.json` path
from bdc-xo main through the existing GitHub CLI authentication route.

The actual origin must be a GitHub HTTPS or scp-style SSH remote. The map
must contain exactly one entry whose normalized owner/repository matches.
`test_command` is used verbatim; `working_subdir` is not prepended because
commands such as ShopOps already contain their directory change.

The resolver emits structured source, fallback reason, blob SHA, and a
base64-encoded command. It does not execute the map text. The existing
restricted runner validates decoded commands and runs argv through its
existing credential scrub and timeout. Unsafe commands fall back to the
spec-declared selection ladder; missing, ambiguous, malformed, or unavailable
maps also report an explicit reason and fall back.

Once a valid mapped command is selected, its result is controlling. Nonzero
exit remains failed, and output without parseable counts remains unparsed.
Neither result is replaced by a passing spec or repository fallback.
Bun workspace `package:test |` and `@scope/package:test |` prefixes are
removed only from the count parser input, after ANSI stripping. Raw logs
retain their prefixes. Other task names and arbitrary pipe prefixes are not
normalized. Existing count arithmetic and exit-status rules are unchanged.

The manifest Tests line records the actual source and, for mapped commands,
the fetched blob SHA. Evidence gates remain unchanged.

The final image retains Node/npm/npx and installs distro-managed pytest.
The image build and Docker CI smoke execute version probes as appuser.
Version probes prove availability, not every repository engine requirement.

## Verification

Run `bun test ./packages/workflows/src/manifest-evidence-lane-wiring.test.ts`
and `bash .archon/workflows/defaults/__tests__/run-stop-tests.sh` from the
repository root, plus the normal generated-default and workflow checks.
The existing six POSIX-only Bash cases remain skipped on Windows; the new
resolver and failure-preservation cases execute on Windows through Git Bash.

A full runtime canary and the rebuilt deployed image remain separate
acceptance requirements. Do not close #2045 solely on source or CI evidence.

## Project-map discrepancy

At the 2026-10-18 source read, the bdc-harness map entry declares `bun test`,
while its note describes executing the package test script. Those operations
are different: `bun run test` invokes the package script. This resolver
preserves the declared command. Correcting that map is separate work in
bdc-xo (PR #3385, merged externally on 2026-10-18); no command rewrite is hidden in the resolver.
