/** Static, hermetic M-131 Phase B Codex seat packaging contract. */
import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { parse } from 'yaml';

const dir = import.meta.dir;
const dockerfile = await Bun.file(join(dir, 'Dockerfile')).text();
const composeRaw = await Bun.file(join(dir, 'docker-compose.codex.example.yml')).text();
const seatConfig = (await Bun.file(join(dir, 'config.seat.codex.example.json')).json()) as {
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
const service = compose.services['bdc-seat-codex'] as ComposeService;

describe('m131 Codex seat container contract', () => {
  test('shared image is non-root and requires an exact build SHA', () => {
    expect(dockerfile).toMatch(/^USER seat$/m);
    expect(dockerfile).not.toMatch(/^USER root$/m);
    expect(dockerfile).toMatch(/^ARG BUILD_SHA$/m);
    expect(dockerfile).toMatch(/test -n "\$\{BUILD_SHA\}"/);
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
    expect(service.volumes).toContain('m131-codex-vendor-profile:/home/seat/.codex');
    expect(service.volumes).toContain('m131-codex-state:/var/lib/bdc-seat');
    expect(compose.volumes).toHaveProperty('m131-codex-vendor-profile');
    expect(compose.volumes).toHaveProperty('m131-codex-state');
    expect(Object.keys(compose.services)).toEqual(['bdc-seat-codex']);
  });

  test('advertises only the Codex CLI with concurrency one', () => {
    expect(seatConfig.seat.model_family).toBe('codex');
    expect(seatConfig.seat.provider_allowlist).toEqual(['codex']);
    expect(seatConfig.agents ?? {}).toEqual({});
    expect(seatConfig.max_concurrency).toEqual({ codex: 1 });
    expect(seatConfig.seat.secret_ingress_file).toBe(
      '/run/m131/secret-ingress/codex-credential.json'
    );
    expect(seatConfig.seat.vendor_profile_dir).toBe('/home/seat/.codex');
    expect(seatConfig.seat.state_dir).toBe('/var/lib/bdc-seat');
    expect(service.healthcheck?.test.join(' ')).toContain('seat-preflight.ts');
  });

  test('no literal secret in Codex seat packaging', () => {
    const content = [dockerfile, composeRaw, JSON.stringify(seatConfig)].join('\n');
    expect(content).not.toMatch(/xai-[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}/);
    expect(content).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
