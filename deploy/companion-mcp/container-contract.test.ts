/**
 * Static container contract for the companion MCP image
 * (WO-HARNESS-COMPANION-MCP-MAILBOX-01). Reads the Dockerfile and compose
 * example as text. No docker daemon, no live host, no credential.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { parse } from 'yaml';

const dir = import.meta.dir;
const dockerfile = await Bun.file(join(dir, 'Dockerfile')).text();
const composeRaw = await Bun.file(join(dir, 'docker-compose.example.yml')).text();

interface ComposeService {
  container_name?: string;
  user?: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
  build?: { args?: Record<string, string> };
}

const compose = parse(composeRaw) as { services: Record<string, ComposeService> };
const service = compose.services['bdc-companion-mcp'];

describe('companion-mcp Dockerfile contract', () => {
  test('runs as a named non-root user', () => {
    expect(dockerfile).toMatch(/^USER companion$/m);
    expect(dockerfile).toMatch(/--uid 10001/);
    expect(dockerfile).not.toMatch(/^USER root$/m);
  });

  test('BUILD_SHA is required and has no placeholder default', () => {
    expect(dockerfile).toMatch(/^ARG BUILD_SHA$/m);
    expect(dockerfile).not.toMatch(/^ARG BUILD_SHA=/m);
    expect(dockerfile).toMatch(/test -n "\$\{BUILD_SHA\}"/);
  });
});

describe('companion-mcp compose contract', () => {
  test('publishes only a tailnet-bound port', () => {
    expect(service).toBeDefined();
    expect(service?.container_name).toBe('bdc-companion-mcp');
    expect(composeRaw).toContain('COMPANION_MCP_TAILNET_IP:?');
    expect(composeRaw).toContain(':3095:3095');
    expect(composeRaw).not.toContain('0.0.0.0:3095');
    expect(composeRaw).not.toMatch(/["']3095:3095["']/);
    expect(service?.ports).toHaveLength(1);
  });

  test('requires BUILD_SHA and a non-wildcard bind address', () => {
    expect(composeRaw).toContain('BUILD_SHA:?');
    expect(composeRaw).not.toContain('BUILD_SHA:-');
    expect(service?.environment?.COMPANION_MCP_BIND_ADDR).toContain('COMPANION_MCP_BIND_ADDR:?');
    expect(service?.environment?.DISPATCH_BASE_URL).toBe('http://archon-app-1:3090');
  });

  test('has no env file and no archon secret or operator token mount', () => {
    expect(composeRaw).not.toMatch(/^env_file:/m);
    expect(composeRaw).not.toMatch(/\n\s+env_file:/);
    expect(composeRaw).not.toContain('/opt/bdc/archon');
    expect(composeRaw).not.toContain('archon-secrets');
    expect(composeRaw).not.toContain('operator-token');
    expect(composeRaw).not.toContain('operator_token');
  });

  test('credential mounts are read-only and only the audit volume is writable', () => {
    const volumes = service?.volumes ?? [];
    const readOnly = volumes.filter(volume => volume.endsWith(':ro'));
    expect(readOnly.some(volume => volume.includes('/var/lib/companion-wiki'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('companions.json'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('/run/companion-mcp/digests'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('/run/companion-mcp/dispatch'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('github-token'))).toBe(true);
    const writable = volumes.filter(volume => !volume.endsWith(':ro'));
    expect(writable).toEqual(['companion-mcp-audit:/var/lib/companion-mcp']);
  });
});
