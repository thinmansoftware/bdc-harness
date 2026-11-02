/** Static, hermetic M-131 Phase B Codex-MCP (ACP/MCP leg) seat packaging contract. */
import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { parse } from 'yaml';

const dir = import.meta.dir;
const dockerfile = await Bun.file(join(dir, 'Dockerfile')).text();
const composeRaw = await Bun.file(join(dir, 'docker-compose.codex-mcp.example.yml')).text();
const seatConfig = (await Bun.file(join(dir, 'config.seat.codex-mcp.example.json')).json()) as {
  seat: Record<string, string | string[]>;
  agents?: Record<string, unknown>;
  max_concurrency: Record<string, number>;
};
interface ComposeService {
  user?: string;
  environment?: Record<string, string>;
  volumes: string[];
  healthcheck?: { test: string[] };
  build?: { args?: Record<string, string> };
}
const compose = parse(composeRaw) as {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};
const service = compose.services['bdc-seat-codex-mcp'] as ComposeService;

describe('m131 Codex-MCP seat container contract', () => {
  test('shared image is non-root and requires an exact build SHA', () => {
    expect(dockerfile).toMatch(/^USER seat$/m);
    expect(dockerfile).not.toMatch(/^USER root$/m);
    expect(service.user).toBe('10001:10001');
    expect(service.build?.args?.BUILD_SHA).toContain('BUILD_SHA');
    expect(service.environment?.SEAT_BUILD_SHA).toContain('BUILD_SHA');
    expect(composeRaw).toContain('BUILD_SHA:?');
    expect(composeRaw).not.toContain('BUILD_SHA:-unknown');
  });

  test('mounts one read-only ingress and isolated writable profile/state volumes', () => {
    const ingress = service.volumes.filter(volume => volume.includes('/run/m131/secret-ingress/'));
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toEndWith(':ro');
    expect(service.volumes).toContain('m131-codex-mcp-vendor-profile:/home/seat/.codex');
    expect(service.volumes).toContain('m131-codex-mcp-state:/var/lib/bdc-seat');
    expect(compose.volumes).toHaveProperty('m131-codex-mcp-vendor-profile');
    expect(compose.volumes).toHaveProperty('m131-codex-mcp-state');
    expect(Object.keys(compose.services)).toEqual(['bdc-seat-codex-mcp']);
  });

  test('advertises only the Codex MCP transport with concurrency one', () => {
    expect(seatConfig.seat.model_family).toBe('codex');
    expect(seatConfig.seat.provider_allowlist).toEqual(['codex-mcp']);
    expect(seatConfig.agents ?? {}).toEqual({});
    expect(seatConfig.max_concurrency).toEqual({ 'codex-mcp': 1 });
    expect(seatConfig.seat.secret_ingress_file).toBe(
      '/run/m131/secret-ingress/codex-credential.json'
    );
    expect(seatConfig.seat.vendor_profile_dir).toBe('/home/seat/.codex');
    expect(seatConfig.seat.state_dir).toBe('/var/lib/bdc-seat');
    expect(service.healthcheck?.test.join(' ')).toContain('seat-preflight.ts');
  });

  test('does not share a home/profile/state with the sibling plain-CLI codex seat', () => {
    expect(seatConfig.seat.vendor_profile_dir).toBe('/home/seat/.codex');
    // Shares the HOST PATH intentionally (same credential family) but the
    // volumes are named distinctly (m131-codex-mcp-* vs m131-codex-*), so the
    // running containers never share a live handle/state.
    expect(compose.volumes).not.toHaveProperty('m131-codex-vendor-profile');
    expect(compose.volumes).not.toHaveProperty('m131-codex-state');
  });

  test('no literal secret in Codex-MCP seat packaging', () => {
    const content = [dockerfile, composeRaw, JSON.stringify(seatConfig)].join('\n');
    expect(content).not.toMatch(/xai-[A-Za-z0-9]{10,}|sk-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}/);
    expect(content).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
