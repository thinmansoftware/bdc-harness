import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const scriptPath = new URL('./sync-codex-auth.ps1', import.meta.url);
const script = readFileSync(scriptPath, 'utf8');

describe('Codex auth sync static contract', () => {
  test('keeps protected auth operations inside the container boundary', () => {
    expect(script).toContain('[string]$ContainerName = "archon-app-1"');
    expect(script).toContain('[string]$ContainerAuthPath = "/root/.codex/auth.json"');

    expect(script).not.toMatch(/-Command\s+"cat \$RemoteAuthPath/);
    expect(script).not.toMatch(/-Command\s+"[^"\r\n]*sha256sum \$RemoteAuthPath/);
    expect(script).not.toMatch(/-Command\s+"[^"\r\n]*cp \$RemoteAuthPath/);
    expect(script).not.toMatch(/-Command\s+"[^"\r\n]*mv \$RemoteTempPath \$RemoteAuthPath/);
    expect(script).not.toContain('chown appuser:appuser');

    const protectedCommandLines = script
      .split(/\r?\n/)
      .filter(
        line =>
          line.includes('$ContainerAuthPath') && /\b(?:cat|sha256sum|cp|mv|stat|chmod)\b/.test(line)
      );
    expect(protectedCommandLines.length).toBeGreaterThan(0);
    for (const line of protectedCommandLines) {
      expect(line).toContain('docker exec');
    }

    expect(script).toMatch(/docker exec \$ContainerName bun -e/);
    expect(script).toMatch(/docker exec \$ContainerName sh -c .*cp .*\$ContainerAuthPath/);
    expect(script).toMatch(/docker exec -i \$ContainerName sh -c .*cat > \$ContainerTempPath/);
    expect(script).toMatch(
      /docker exec \$ContainerName sh -c .*mv \$ContainerTempPath \$ContainerAuthPath/
    );
    expect(script).toMatch(/docker exec \$ContainerName bun -e .*readCodexFreshness/);
    expect(script).toContain('$stamp = Get-Date -Format "yyyyMMdd-HHmmss"');
    expect(script).toContain('$backupPath = "$ContainerAuthPath.bak.$stamp"');
    expect(script).toMatch(
      /docker exec \$ContainerName sh -c .*cp .*\$backupPath.*[\s\S]*verify_probe_failed/
    );
  });

  test('compares JWT issue time before using the opaque-token mtime fallback', () => {
    expect(script).toContain('function Get-LocalJwtIssuedAtSeconds');
    expect(script).toContain('iat');
    expect(script).toMatch(
      /if \(\$null -ne \$desktopIssuedAtSeconds -and \$null -ne \$remoteIssuedAtSeconds\)/
    );
    expect(script).toMatch(/else \{\s*\$comparison = "mtime_fallback"/);
  });

  test('restricts completion details to redacted metadata and status labels', () => {
    const detailArguments = [...script.matchAll(/-Detail\s+"([^"]*)"/g)].map(match => match[1]);

    expect(detailArguments.length).toBeGreaterThan(0);
    for (const detail of detailArguments) {
      expect(detail).not.toMatch(/(?:path|backup|error|type|token|auth)=/i);
      expect(detail).not.toContain('$DesktopAuthPath');
      expect(detail).not.toContain('$ContainerAuthPath');
      expect(detail).not.toContain('$backupPath');
      expect(detail).not.toContain('$_');
    }

    expect(script).toContain('$desktopHash.Substring(0, 8)');
    expect(script).toContain('$remoteHash.Substring(0, 8)');
    expect(script).toMatch(/desktop_bytes=\$desktopBytes/);
    expect(script).toMatch(/remote_bytes=\$remoteBytes/);
  });
});
