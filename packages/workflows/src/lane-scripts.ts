/**
 * Lane shell scripts (scripts/lane/*.sh) for bash nodes.
 *
 * Lane YAMLs SOURCE shared shell cores (dprep.sh) instead of inlining them. The
 * Docker image ships them at /app/scripts/lane/, but standalone CLI installs and
 * source runs have no /app. The bundle generator embeds scripts/lane/*.sh into
 * BUNDLED_LANE_SCRIPTS (one source of truth), and the bash node executor writes
 * them into a per-node directory exported as ARCHON_LANE_SCRIPTS_DIR. Only nodes
 * whose script references that variable pay for the write.
 */
import { chmod, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { BUNDLED_LANE_SCRIPTS } from './defaults/bundled-defaults';

export const LANE_SCRIPTS_ENV = 'ARCHON_LANE_SCRIPTS_DIR';

/** True when a bash node script reads ARCHON_LANE_SCRIPTS_DIR. */
export function scriptUsesLaneScripts(script: string): boolean {
  return script.includes(LANE_SCRIPTS_ENV);
}

/**
 * Write every bundled lane script into `dir` (created if needed, mode 0700; files
 * 0600 -- they are sourced, never executed). Returns `dir`.
 */
export async function materializeLaneScripts(
  dir: string,
  scripts: Readonly<Record<string, string>> = BUNDLED_LANE_SCRIPTS
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(scripts)) {
    if (!/^[a-z0-9][a-z0-9-]*\.sh$/.test(name)) {
      throw new Error(`invalid lane script name: ${name}`);
    }
    const file = join(dir, name);
    await writeFile(file, content, { mode: 0o600 });
    await chmod(file, 0o600);
  }
  return dir;
}
