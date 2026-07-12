import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = new URL('./sync-codex-auth.ps1', import.meta.url);
const script = readFileSync(scriptPath, 'utf8');
const tempDirectories: string[] = [];

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(command: string): ReturnType<typeof spawnSync> {
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
    }
  );
}

function functionExtractionPrelude(functionNames: string[]): string {
  return functionNames
    .map(
      functionName => `
$source = [IO.File]::ReadAllText(${quotePowerShellLiteral(decodeURIComponent(scriptPath.pathname.slice(1)))})
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$functionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq ${quotePowerShellLiteral(functionName)}
}, $true)
if ($null -eq $functionAst) { throw ${quotePowerShellLiteral(`Missing function ${functionName}`)} }
Invoke-Expression $functionAst.Extent.Text
`
    )
    .join('\n');
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Codex auth sync static contract', () => {
  test('keeps every protected auth operation inside docker exec', () => {
    expect(script).not.toContain('$RemoteAuthPath');
    expect(script).not.toContain('/opt/bdc/archon-user-home/.codex/auth.json');
    expect(script).not.toMatch(/\bscp\b/);
    expect(script).not.toContain('chown appuser:appuser');
    expect(script).not.toMatch(/Get-Content[^\r\n]*\|[\s\r\n]*& ssh/);
    expect(script).not.toMatch(/docker exec[^\r\n]*sh -c/);

    const protectedOperations = script
      .split(/\r?\n/)
      .filter(line => /(?:\$ContainerAuthPath|\/root\/\.codex\/auth\.json)/.test(line))
      .filter(line => /\b(?:cat|sha256sum|cp|dd|mv|rm|stat|chmod)\b/.test(line));
    expect(protectedOperations.length).toBeGreaterThan(0);
    for (const line of protectedOperations) {
      expect(line).toContain('docker exec');
    }

    expect(script).toMatch(/docker exec \$ContainerName bun -e/);
    expect(script).toMatch(/docker exec -i \$ContainerName dd /);
    expect(script).toMatch(/docker exec \$ContainerName chmod 600 \$ContainerTempPath/);
    expect(script).toMatch(
      /docker exec \$ContainerName mv -f \$ContainerTempPath \$ContainerAuthPath/
    );
    expect(script).toContain('readCodexFreshness(process.argv[1])');
    expect(script).toMatch(/docker exec \$ContainerName bun -e '\$probe' \$ContainerAuthPath/);
  });

  test('uses native file-handle redirection rather than a PowerShell text pipeline', () => {
    expect(script).toContain('function Invoke-BinaryRedirectedCommand');
    expect(script).toContain('$startInfo.FileName = $env:ComSpec');
    expect(script).toContain('< `"$InputPath`"');
    expect(script).not.toContain('RedirectStandardInput');
    expect(script).not.toContain('StandardInput');
  });

  test('restores atomically or removes a rejected first credential', () => {
    expect(script).toContain('$targetExisted = [bool]$containerMetadata.exists');
    expect(script).toContain('$restorePath = "$ContainerAuthPath.restore.$stamp"');
    expect(script).toMatch(
      /if \(\$targetExisted\) \{[\s\S]*docker exec \$ContainerName cp -- \$backupPath \$restorePath/
    );
    expect(script).toMatch(/docker exec \$ContainerName chmod 600 \$restorePath/);
    expect(script).toMatch(/docker exec \$ContainerName mv -f \$restorePath \$ContainerAuthPath/);
    expect(script).toMatch(
      /else \{[\s\r\n]*Invoke-RemoteChecked -Command "docker exec \$ContainerName rm -f \$ContainerAuthPath"/
    );
  });

  test('fixes the protected path, validates identifiers, and passes Bun data via argv', () => {
    expect(script).not.toContain('[string]$ContainerAuthPath');
    expect(script).toContain('$ContainerAuthPath = "/root/.codex/auth.json"');
    expect(script).toContain('function Assert-SafeIdentifier');
    expect(script).toContain('Assert-SafeIdentifier -Name "SshAlias" -Value $SshAlias');
    expect(script).toContain('Assert-SafeIdentifier -Name "ContainerName" -Value $ContainerName');
    expect(script).toContain('process.argv[1]');
    expect(script).not.toMatch(/const p=['"]\$ContainerAuthPath/);
    expect(script).not.toMatch(/readCodexFreshness\(['"]\$ContainerAuthPath/);
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

describe('Codex auth sync local integration', () => {
  test('copies BOM and CRLF credential bytes to process stdin without hash changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-auth-sync-'));
    tempDirectories.push(directory);
    const inputPath = join(directory, 'input.bin');
    const outputPath = join(directory, 'output.bin');
    const helperPath = join(directory, 'stdin-copy.mjs');
    const input = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from('{"tokens":{"access_token":"opaque"}}\r\n', 'utf8'),
    ]);
    writeFileSync(inputPath, input);
    writeFileSync(
      helperPath,
      "import { createWriteStream } from 'node:fs'; process.stdin.pipe(createWriteStream(process.argv[2]));\n",
      'ascii'
    );

    const command = `${functionExtractionPrelude(['Invoke-BinaryRedirectedCommand'])}
Invoke-BinaryRedirectedCommand -FileName ${quotePowerShellLiteral(process.execPath)} -Arguments ${quotePowerShellLiteral(`"${helperPath}" "${outputPath}"`)} -InputPath ${quotePowerShellLiteral(inputPath)}
`;
    const result = runPowerShell(command);

    expect(result.status).toBe(0);
    const output = readFileSync(outputPath);
    expect(output).toEqual(Buffer.from(input));
    expect(createHash('sha256').update(output).digest('hex')).toBe(
      createHash('sha256').update(input).digest('hex')
    );
  });

  test('rejects hostile SSH aliases and container names locally', () => {
    const command = `${functionExtractionPrelude(['Assert-SafeIdentifier'])}
Assert-SafeIdentifier -Name 'SshAlias' -Value 'hetzner-prod'
Assert-SafeIdentifier -Name 'ContainerName' -Value 'archon-app-1'
$hostile = @('prod;touch-pwned', '../escape', 'name with spaces', 'x$(whoami)')
foreach ($value in $hostile) {
  $rejected = $false
  try { Assert-SafeIdentifier -Name 'test' -Value $value } catch { $rejected = $true }
  if (-not $rejected) { throw "Accepted hostile identifier" }
}
`;
    const result = runPowerShell(command);

    expect(result.status).toBe(0);
  });
});
