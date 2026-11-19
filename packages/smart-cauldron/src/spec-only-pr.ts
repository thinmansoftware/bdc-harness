/**
 * Classify a decoded PR file list without I/O. Both sides of every rename must
 * be exact spec paths for this WO; empty or malformed lists prove nothing.
 */
export function isSpecOnlyFileList(woId: string, entries: unknown): boolean {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const specPaths = new Set([`docs/work-orders/${woId}.md`, `docs/superpowers/specs/${woId}.md`]);
  return entries.every((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return false;
    const { filename, previous_filename: previousFilename } = entry as {
      filename?: unknown;
      previous_filename?: unknown;
    };
    return (
      typeof filename === 'string' &&
      specPaths.has(filename) &&
      (previousFilename === undefined ||
        (typeof previousFilename === 'string' && specPaths.has(previousFilename)))
    );
  });
}
