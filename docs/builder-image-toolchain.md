Per-project toolchain (Node 26 + pnpm)

The builder image pins Node 26.12.1 and pnpm 12.14.0 beside Debian Node and the
bun 1.3.11 server runtime. Repos that do not use pnpm are unchanged.

Pins and paths

Three artifacts are downloaded at image build time and verified with sha256sum
before they are unpacked. Nothing is downloaded again at runtime.

- Node 26.12.1 comes from the official Node linux-x64 archive. NODE26_SHA256
  verifies node-v26.12.1-linux-x64.tar.xz. It is unpacked at /opt/node26 and
  stays off the global PATH. pnpm-spawned commands use this Node.
- The pnpm 12.14.0 wrapper comes from the pnpm registry archive. PNPM_SHA256
  verifies pnpm-12.14.0.tgz. It is unpacked at /opt/pnpm-12.14.0 and keeps
  package.json and dist/.
- The native linux-x64 pnpm comes from @pnpm/exe.linux-x64.
  PNPM_NATIVE_SHA256 verifies exe.linux-x64-12.14.0.tgz. Only that archive's
  package/pnpm is installed over /opt/pnpm-12.14.0/pnpm. The wrapper
  package.json and dist/ stay in place.
- The selector is /usr/local/bin/pnpm, installed from
  scripts/container/project-pnpm.sh (project-pnpm).

How project-pnpm selects

project-pnpm walks upward from the working directory to the nearest package.json
and reads packageManager with jq.

- pnpm@12.14.0, pnpm@12.14.0 plus a +sha suffix, or no package.json / no
  packageManager: /usr/local/bin/pnpm executes the native binary at
  /opt/pnpm-12.14.0/pnpm directly. It prepends /opt/node26/bin only to that
  process tree's PATH. It does not run pnpm through Node.
- Any other pnpm@X: exit 1 and write
  "project-pnpm: unsupported pnpm version X (image provides 12.14.0)" to stderr.
  A +sha suffix on X is removed before the message is printed. Nothing is downloaded.
- Any other package manager value, including yarn@4: exit 1 and write
  "project-pnpm: unsupported packageManager <value> (image provides pnpm@12.14.0)"
  to stderr.
- project-pnpm never downloads a package manager and never edits package.json.

Dependency prep

Bun lockfiles win. dprep_ensure_js_deps keeps the existing bun install path when
bun.lock or bun.lockb is present.

The pnpm dprep branch runs only when there is no bun lock, pnpm-lock.yaml exists,
pnpm is on PATH, and node_modules is absent. It then runs pnpm install --frozen-lockfile
inside the same credential-scrubbed subshell as the bun branch, and it always returns 0.

The npm dprep branch runs only when there is no bun lock and no pnpm-lock.yaml, and
package-lock.json exists. It runs npm ci --no-audit --no-fund in the same scrubbed
subshell and logs "dprep: npm ci (package-lock.json)". Any other package dir skips.

dprep_ensure_js_deps lives in one shared file, scripts/lane/dprep.sh. The prep-dependencies
and run-stop-tests nodes of every bdc-feature-development lane source it, trying in order:
$BDC_DPREP_SCRIPT (tests), $ARCHON_LANE_SCRIPTS_DIR/dprep.sh, then
/app/scripts/lane/dprep.sh (the Docker image copy). The bundle generator embeds
scripts/lane/*.sh as BUNDLED_LANE_SCRIPTS, and the bash node executor writes them into a
per-node directory exported as ARCHON_LANE_SCRIPTS_DIR (only for nodes whose script reads
that variable; removed when the node ends), so standalone CLI and source runs work
without /app. Only when no candidate exists does the node log "dprep: dprep.sh missing"
and continue.

Base-red aware stop tests (scripts/lane/stop-tests-base.sh)

A build fails its test stop condition only for tests it newly broke. The second lane
script, scripts/lane/stop-tests-base.sh, is bundled and resolved the same way as dprep.sh:
$BDC_STBASE_SCRIPT (tests), $ARCHON_LANE_SCRIPTS_DIR/stop-tests-base.sh, then
/app/scripts/lane/stop-tests-base.sh. Every bdc-feature-development lane sources it twice,
through one byte-identical "stbase core" stub in run-stop-tests and in
stamp-manifest-evidence, and makes one call in each node:

- run-stop-tests writes rst_report's lines to $ARTIFACTS_DIR/evidence/stop-tests.report,
  then calls rst_base_compare <report> <commands-file> <head-log> <head-counts>.
  When the head status is not "failed" it prints the report unchanged and never touches
  the base. When it is "failed", it reads the run's base commit from
  $ARTIFACTS_DIR/run-start-sha.txt, adds a detached worktree at
  $ARTIFACTS_DIR/stop-tests-base-wt.<pid>, runs dprep_ensure_js_deps and the same commands
  there through rst_run_commands (same per-command timeout), logs to
  $ARTIFACTS_DIR/evidence/stop-tests-base.log, and always removes the worktree.
  Evidence is judged per command (one "### run-stop-tests:" block of the log each): every
  head command that exited nonzero or reported a failing test must have its own parsed
  counts, no timeout, and exactly one file-attributed name per failing test with no name
  repeated; otherwise the result fails closed before the base runs. A test's identity is
  command index + file + name, so one command's names never cover another command's
  failures and equal names in different files never match. Files and names come from bun
  "<file>:" / "::group::<file>:" headers plus "(fail) <name>", node:test "# Subtest:
  <file>" plus "not ok <n> - <name>", jest "FAIL <file>" plus bullet lines, and vitest
  "FAIL <file> > <name>" lines. If every head failure also
  fails on base, it prints TESTS_STATUS=base_red and
  TESTS_LINE=<pass>/<total> (base-red: <k> tests failing on base <sha8>; newly broken: 0)
  and writes the names to $ARTIFACTS_DIR/base-red-tests.txt. Otherwise the status stays
  failed (with "newly broken: <names>" when known). A missing or bad base sha, missing
  counts, failures that cannot be named, a base timeout (exit 124) or a worktree that
  cannot be created all fail closed. Before the base run every
  spelling of the head checkout root in a command (git form, pwd and pwd -P, cygpath
  forms, trailing slash) is rebased onto the base worktree; a command that still names
  the head root (in any letter case) or cds to an absolute directory outside the base
  worktree fails closed as escapes_worktree, and the base never runs. It always appends TESTS_BASE_COMPARE=<outcome>
  (not_failed, base_red, newly_broken, base_passed, unparsed, no_base_sha, no_counts,
  base_timeout, base_unrunnable, escapes_worktree, or script_missing from the fallback stub).
- stamp-manifest-evidence pipes sme_process's output through stb_stamp_base_red, which
  adds "Base-red tests: <a>; <b> ..." after the Tests: line when base-red-tests.txt lists
  names. sme_process and manifest-evidence-check accept base_red because its Tests: line
  starts with <pass>/<total> and its status is not "failed".

Tests: bash .archon/workflows/defaults/__tests__/run-stop-tests.sh (Tests 1-10 of
WO-HARNESS-STOP-TESTS-BASE-RED-AWARE-01, against real temporary git repos).

Bumping a version

Change each version and its checksum together, from the publisher checksums.
All three version/checksum pairs are updated together.

- Node checksum: the node-v<version>-linux-x64.tar.xz line in
  https://nodejs.org/dist/v<version>/SHASUMS256.txt (NODE26_VERSION and NODE26_SHA256).
- pnpm wrapper checksum: the SHA-256 of
  https://registry.npmjs.org/pnpm/-/pnpm-<version>.tgz (PNPM_VERSION and PNPM_SHA256).
- Native pnpm checksum: the SHA-256 of
  https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-<version>.tgz
  (PNPM_NATIVE_SHA256). The version matches PNPM_VERSION.

When it goes live

A green docker-build check is image proof. CI builds archon-ci:test and runs the
offline pnpm probe plus the existing smoke tests. That check does not change the
running container.

The live container changes only after the next XO-governed Rule 11.5 harness
rebuild. Stop 9 verifies that rebuild, and it is separate from CI image proof.
