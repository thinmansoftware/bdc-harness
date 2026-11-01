/**
 * Loader so `bun test scripts/container` (a name filter) runs the boot-chown
 * suite. bunfig test.root is one directory, ./packages, so this file lives
 * under that root. The suite itself stays in scripts/container.
 */
import '../../../../scripts/container/docker-entrypoint-boot-chown.test.ts';
