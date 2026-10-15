/** Only stable, exact Codex SDK versions with GPT-6 support are accepted. */
export function isAcceptableCodexSdkPin(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match;
  return Number(major) > 0 || Number(minor) >= 155;
}
