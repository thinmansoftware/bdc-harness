import type { Baseline, Finding } from './types';

export const fixtureBaseline: Baseline = {
  schemaVersion: 1,
  expectedOpenPorts: [
    { port: 22, protocol: 'tcp', addressFamily: 'any', allowedSources: ['john-home'], reason: 'ssh' },
    { port: 80, protocol: 'tcp', addressFamily: 'any', allowedSources: ['public'], reason: 'http' },
    { port: 443, protocol: 'tcp', addressFamily: 'any', allowedSources: ['public'], reason: 'https' },
  ],
  legitimateAnonGrants: [
    {
      instance: 'prod',
      schema: 'public',
      table: 'public_profiles',
      reason: 'public read table with RLS policy',
    },
  ],
  authorizedWebhooks: [{ path: '/webhook/order-status', methods: ['POST'], reason: 'signed order status hook' }],
  containerInventory: [
    {
      name: 'lspro-react',
      required: true,
      secretFilePaths: ['/app/.env'],
      checks: ['running', 'no-default-env', 'healthcheck', 'expected-image'],
    },
  ],
};

export const cleanFinding: Finding = {
  module: 'legacy-twelve',
  severity: 'CLEAN',
  target: 'lspro-react',
  evidence: { status: 'running' },
  reason_code: 'container_running',
};

export const criticalFinding: Finding = {
  module: 'port-exposure',
  severity: 'CRITICAL',
  target: '5.78.86.90:11434/tcp',
  evidence: { public_prober: 'open' },
  reason_code: 'unexpected_public_port',
};
