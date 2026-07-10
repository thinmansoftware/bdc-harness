import type { Baseline, Finding } from '../types';

export type FileModeReader = (path: string) => Promise<{ readonly exists: boolean; readonly mode: number }>;

export async function scanWorldReadableFiles(baseline: Baseline, readMode: FileModeReader): Promise<readonly Finding[]> {
  const paths = [...new Set(baseline.containerInventory.flatMap(container => container.secretFilePaths))].sort();
  const findings: Finding[] = [];
  for (const path of paths) {
    const stat = await readMode(path);
    if (!stat.exists) {
      findings.push({
        module: 'world-readable',
        severity: 'MEDIUM',
        target: path,
        evidence: { exists: false },
        reason_code: 'credential_file_not_found',
      });
      continue;
    }
    const worldReadable = (stat.mode & 0o004) !== 0;
    findings.push({
      module: 'world-readable',
      severity: worldReadable ? 'HIGH' : 'CLEAN',
      target: path,
      evidence: { mode: stat.mode.toString(8), world_readable: worldReadable },
      reason_code: worldReadable ? 'credential_file_world_readable' : 'credential_file_mode_clean',
    });
  }
  return findings;
}
