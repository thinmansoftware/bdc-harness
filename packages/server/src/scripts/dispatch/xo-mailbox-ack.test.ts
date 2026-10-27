// Discovery shim. Root bunfig.toml sets [test].root to ./packages, so
// `bun test scripts/dispatch/xo-mailbox-ack.test.ts` only matches files under
// packages/. Importing the script suite registers those tests. This file is
// excluded from the production image by **/*.test.ts in .dockerignore.
import '../../../../../scripts/dispatch/xo-mailbox-ack.test.ts';
