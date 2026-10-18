# Supervised tee-time dependency acquisition candidate

Source preparation for bdc-xo#3332 and accepted source proposal bdc-xo PR3391.
This is not an admitted app run, app implementation or deployable preview.

Create one fresh operator-owned context containing exactly two regular files:
Dockerfile (these Dockerfile.teetime-demo-deps bytes) and teetime-demo-package.json.
Verify that exact inventory and both file hashes before building. Do not use the
scripts/staging directory as the context. No app, repository, auth, environment
file or model prompt is copied. Never build from the workspace root or home.

Inputs are explicit Linux amd64 registry manifests for Bun1.3.11 and the matching
Playwright1.64.1 browser/dependency image. Node24.22.0 is downloaded from nodejs.org
and checked against the retained official checksum. This is checksum verification,
not a signature-verification assertion. Package install runs unprivileged with an
explicit replacement environment, no account/proxy tokens and lifecycle scripts
disabled. It generates a complete lock once; it does not pretend that lock was
already frozen. The fixed versions do not prove runtime compatibility by themselves.

Before acquisition: independent exact-source recipe review and hash the minimal
context. Explicitly select linux/amd64, no additional contexts or secret/SSH mounts.
Bound the build client to15 minutes on the existing isolated BDC Docker laptop;
no credentials, secret mounts, build arguments, host network, ports or app source.
Network is needed only for the fixed public image, Node and npm acquisition.
Record actual source/context/manifest/image identities and the build result. Enforce
the deadline, record client termination/cancellation, and retain timeout as failure.
A stopped client alone does not prove daemon-side work stopped. On timeout reconcile
this owned build activity before any retry; never prune shared build resources.

After successful acquisition: use an owned no-network read-only container to read
the exact package.json and complete bun.lock, executable/version identities, native
SWC and browser revisions. The image is an acquisition OUTPUT; freeze its actual
digest before any model/test use. Retain the complete lock and inspect its resolved
sources/integrity entries without truncation. Derive the complete prepared base
from committed app bytes plus separately reviewed immutable dependency/config
assets; model operations cannot modify those paths.

No app build, browser sandbox, reproducible reinstall, readonly build behavior,
model launcher extension, authority/claim integration or demo acceptance is proven
by this image. Test the actual browser sandbox and fixed commands before case
freeze. Do not add --no-sandbox, host IPC, privilege or broad capabilities to make
it pass. These are development/test dependencies, not a production runtime image.

Rollback is removal of only the newly created owned acquisition resources. Preserve
existing qualified images, shared Docker services and previous failed evidence.
Never run broad image/container/volume pruning. Source publication alone does not
authorize an account-bearing or application run.
