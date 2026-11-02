import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePolicyTupleDigest,
  loadOverseerActionPolicyRegistry,
  POLICY_TUPLE_ALGORITHM,
} from '../policy-registry';
import {
  gitBlobOid,
  runPolicyRegistryVerifyCli,
  verifyPolicyRegistryIdentities,
  type PolicyIdentityEvidence,
} from '../policy-registry-verify';

const SYNTHETIC_FILE = fileURLToPath(
  new URL('./fixtures/overseer-action-policy.synthetic.json', import.meta.url)
);
const SHIPPED_FILE = fileURLToPath(
  new URL('../../../../.archon/policies/overseer-action-policy.json', import.meta.url)
);

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestsOf(bytes: Buffer): string[] {
  const registry = loadOverseerActionPolicyRegistry({ text: bytes.toString('utf8') });
  return registry.entries
    .map(entry =>
      computePolicyTupleDigest({
        owner: entry.owner,
        repository: entry.repository,
        base_branch: entry.base_branch,
        resulting_deployment_effect: entry.resulting_deployment_effect,
        allowed_action_kinds: entry.allowed_action_kinds,
        credential_principal: entry.credential_principal,
      })
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function buildEvidence(
  path: string,
  manifestKey: 'shipped_policy_evidence' | 'fake_policy_evidence'
): { bytes: Buffer; evidence: PolicyIdentityEvidence } {
  const bytes = readFileSync(path);
  const digests = digestsOf(bytes);
  const evidence: PolicyIdentityEvidence = {
    registry_path: path,
    policy_tuple_algorithm: POLICY_TUPLE_ALGORITHM,
    policy_tuple_digests: digests,
    git_object_format: 'sha1',
    git_blob_oid: gitBlobOid(bytes, 'sha1'),
    registry_file_sha256: sha256(bytes),
    ...(manifestKey === 'fake_policy_evidence'
      ? { proposal_policy_tuple_digest: digests[0], receipt_policy_tuple_digest: digests[0] }
      : {}),
  };
  return { bytes, evidence };
}

describe('verifyPolicyRegistryIdentities', () => {
  test('fixture paths resolve cross-platform without Windows /C: pathname bug', () => {
    expect(SYNTHETIC_FILE.includes('/C:')).toBe(false);
    expect(SHIPPED_FILE.includes('/C:')).toBe(false);
    expect(existsSync(SYNTHETIC_FILE)).toBe(true);
    expect(existsSync(SHIPPED_FILE)).toBe(true);
    // A direct read proves the path is usable on this host OS.
    expect(readFileSync(SYNTHETIC_FILE).length).toBeGreaterThan(0);
    expect(readFileSync(SHIPPED_FILE).length).toBeGreaterThan(0);
  });

  test('fake evidence for the synthetic registry is valid', () => {
    const { bytes, evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence,
      manifestKey: 'fake_policy_evidence',
      detectedGitObjectFormat: 'sha1',
    });
    expect(result.valid).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  test('shipped evidence for the live registry is valid', () => {
    const { bytes, evidence } = buildEvidence(SHIPPED_FILE, 'shipped_policy_evidence');
    // Populated 2026-07-20 with the first real entry -- one tuple digest now.
    expect(evidence.policy_tuple_digests).toHaveLength(1);
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence,
      manifestKey: 'shipped_policy_evidence',
      detectedGitObjectFormat: 'sha1',
    });
    expect(result.valid).toBe(true);
  });

  test('raw-file SHA-256 mismatch fails closed', () => {
    const { bytes, evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence: { ...evidence, registry_file_sha256: 'f'.repeat(64) },
      manifestKey: 'fake_policy_evidence',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('registry_file_sha256_mismatch');
  });

  test('git blob OID mismatch fails closed and is separate from raw-file SHA-256', () => {
    const { bytes, evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    // The blob OID and the raw-file SHA-256 are distinct values.
    expect(evidence.git_blob_oid).not.toBe(evidence.registry_file_sha256);
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence: { ...evidence, git_blob_oid: '0'.repeat(40) },
      manifestKey: 'fake_policy_evidence',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('git_blob_oid_mismatch');
  });

  test('wrong tuple algorithm fails closed', () => {
    const { bytes, evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence: { ...evidence, policy_tuple_algorithm: 'sha256' },
      manifestKey: 'fake_policy_evidence',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('policy_tuple_algorithm_mismatch');
  });

  test('tuple-digest set mismatch fails closed', () => {
    const { bytes, evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence: { ...evidence, policy_tuple_digests: ['a'.repeat(64)] },
      manifestKey: 'fake_policy_evidence',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('policy_tuple_digests_mismatch');
  });

  test('fake proposal/receipt digest mismatch fails closed', () => {
    const { bytes, evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence: { ...evidence, proposal_policy_tuple_digest: 'b'.repeat(64) },
      manifestKey: 'fake_policy_evidence',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('proposal_policy_tuple_digest_mismatch');
  });

  test('shipped evidence carrying fake-only fields fails closed', () => {
    const { bytes, evidence } = buildEvidence(SHIPPED_FILE, 'shipped_policy_evidence');
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence: { ...evidence, proposal_policy_tuple_digest: 'c'.repeat(64) },
      manifestKey: 'shipped_policy_evidence',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('shipped_policy_unexpected_fake_fields');
  });

  test('declared object format disagreeing with the repo fails closed', () => {
    const { bytes, evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence,
      manifestKey: 'fake_policy_evidence',
      detectedGitObjectFormat: 'sha256',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('git_object_format_disagrees_with_repo');
  });

  test('non-object evidence fails closed', () => {
    const bytes = readFileSync(SYNTHETIC_FILE);
    const result = verifyPolicyRegistryIdentities({
      registryBytes: bytes,
      evidence: null,
      manifestKey: 'fake_policy_evidence',
    });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('evidence_not_object');
  });
});

describe('runPolicyRegistryVerifyCli', () => {
  let tmp: string | undefined;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  function captureStdout(fn: () => number): { code: number; out: string; err: string } {
    let out = '';
    let err = '';
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    const code = fn();
    return { code, out, err };
  }

  function writeManifest(
    key: 'shipped_policy_evidence' | 'fake_policy_evidence',
    path: string
  ): string {
    tmp = tmp ?? mkdtempSync(join(tmpdir(), 'policy-verify-'));
    const { evidence } = buildEvidence(path, key);
    const manifestPath = join(tmp, `manifest-${key}.json`);
    writeFileSync(manifestPath, JSON.stringify({ [key]: evidence }));
    return manifestPath;
  }

  test('prints exactly POLICY_IDENTITIES=valid for the shipped registry', () => {
    const manifest = writeManifest('shipped_policy_evidence', SHIPPED_FILE);
    const { code, out } = captureStdout(() =>
      runPolicyRegistryVerifyCli([
        '--registry',
        SHIPPED_FILE,
        '--manifest',
        manifest,
        '--manifest-key',
        'shipped_policy_evidence',
      ])
    );
    expect(code).toBe(0);
    expect(out).toBe('POLICY_IDENTITIES=valid\n');
  });

  test('prints exactly POLICY_IDENTITIES=valid for the synthetic fixture', () => {
    const manifest = writeManifest('fake_policy_evidence', SYNTHETIC_FILE);
    const { code, out } = captureStdout(() =>
      runPolicyRegistryVerifyCli([
        '--registry',
        SYNTHETIC_FILE,
        '--manifest',
        manifest,
        '--manifest-key',
        'fake_policy_evidence',
      ])
    );
    expect(code).toBe(0);
    expect(out).toBe('POLICY_IDENTITIES=valid\n');
  });

  test('exits non-zero when the manifest digest disagrees', () => {
    tmp = mkdtempSync(join(tmpdir(), 'policy-verify-'));
    const { evidence } = buildEvidence(SYNTHETIC_FILE, 'fake_policy_evidence');
    const manifestPath = join(tmp, 'bad.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        fake_policy_evidence: { ...evidence, registry_file_sha256: '0'.repeat(64) },
      })
    );
    const { code, out, err } = captureStdout(() =>
      runPolicyRegistryVerifyCli([
        '--registry',
        SYNTHETIC_FILE,
        '--manifest',
        manifestPath,
        '--manifest-key',
        'fake_policy_evidence',
      ])
    );
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('POLICY_IDENTITIES=invalid');
  });

  test('exits non-zero on a missing required flag', () => {
    const { code, err } = captureStdout(() =>
      runPolicyRegistryVerifyCli(['--registry', SYNTHETIC_FILE])
    );
    expect(code).toBe(1);
    expect(err).toContain('POLICY_IDENTITIES=invalid');
  });
});
