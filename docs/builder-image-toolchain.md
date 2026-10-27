Per-project toolchain (Node 26 + pnpm)

The builder image pins Node 26.12.1 and pnpm 12.14.0 beside Debian Node and the
bun 1.3.11 server runtime. Repos that do not use pnpm are unchanged.

Pins and paths

- Node 26.12.1 is unpacked to /opt/node26. /opt/node26 is off the global PATH.
- pnpm 12.14.0 is unpacked to /opt/pnpm-12.14.0.
- The selector is /usr/local/bin/pnpm, installed from scripts/container/project-pnpm.sh (project-pnpm).

How project-pnpm selects

project-pnpm walks upward from the working directory to the nearest package.json
and reads packageManager with jq.

- pnpm@12.14.0, pnpm@12.14.0 plus a +sha suffix, or no package.json / no packageManager:
  run /opt/pnpm-12.14.0/pnpm with /opt/node26/bin/node. /opt/node26/bin is prepended
  to PATH for that process tree only.
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

Change the version ARG and the checksum ARG together.

- Node checksum: the node-v<version>-linux-x64.tar.xz line in
  https://nodejs.org/dist/v<version>/SHASUMS256.txt.
- pnpm checksum: the SHA-256 of
  https://registry.npmjs.org/pnpm/-/pnpm-<version>.tgz.

When it goes live

Merging this change does not alter the running container. The pins go live only
on the next governed harness rebuild by the XO under Rule 11.5.
