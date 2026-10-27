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
