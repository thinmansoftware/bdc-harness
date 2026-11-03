import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdviceLedger } from './ledger';
import { AdviceService, type AdviceClient, type ModelRequest } from './service';

const lease = {
  lease_id: 'lease-1',
  principal_id: 'stage-xo',
  fencing_token: 1,
  expires_at: new Date(Date.now() + 600_000).toISOString(),
};
const principal = { principal_id: 'stage-xo', seat_id: 'xo' as const, roles: [] };
function packet(task = 'Summarize the captured status') {
  return {
    request_id: crypto.randomUUID(),
    lease_id: lease.lease_id,
    fencing_token: 1,
    task,
    category: 'status',
    captured_at: new Date().toISOString(),
    evidence: [
      {
        id: 'E1',
        url: 'https://github.com/thinmansoftware/bdc-harness/pull/1377',
        content: 'Captured status only; no source execution.',
      },
    ],
  };
}
async function setup(
  run: (s: AdviceService, seen: ModelRequest[], ledger: AdviceLedger) => Promise<void>,
  options: {
    badCitation?: boolean;
    unknown?: boolean;
    moveLease?: boolean;
    badReceipt?: boolean;
    badIdentity?: boolean;
    consequentialOutput?: boolean;
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'xo-advice-service-'));
  const ledger = new AdviceLedger(join(dir, 'pilot.sqlite'));
  const seen: ModelRequest[] = [];
  const client: AdviceClient = {
    prices: async () => ({ prompt: 0.000004, completion: 0.000015 }),
    complete: async req => {
      seen.push(req);
      return {
        id: 'gen-' + seen.length,
        model: options.badIdentity ? 'unrequested-model' : req.model,
        status: 'completed',
        usage: options.unknown ? {} : { cost: 0.01 },
        output: [
          {
            type: 'function_call',
            name: 'submit_brief',
            arguments: JSON.stringify({
              summary: options.consequentialOutput
                ? 'Production readiness requires review.'
                : 'TERRA_SECRET_OPINION',
              claims: [
                {
                  claim: 'Captured status',
                  evidence_ids: [options.badCitation ? 'INVENTED' : 'E1'],
                },
              ],
              next_steps: ['Verify before acting'],
              missing_evidence: ['Live runtime'],
              important: false,
              live_change_authorized: false,
            }),
          },
        ],
      };
    },
    receipt: async id => ({
      id,
      model: seen[seen.length - 1].model,
      provider_name: options.badReceipt ? 'Other' : 'OpenAI',
      total_cost: 0.01,
    }),
  };
  const service = new AdviceService(ledger, client, async () =>
    options.moveLease && seen.length ? { ...lease, fencing_token: 2 } : lease
  );
  try {
    await run(service, seen, ledger);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test('consequential output cannot suppress Sol with important=false', async () =>
  setup(
    async (s, seen) => {
      await s.run(packet(), principal);
      expect(seen).toHaveLength(2);
    },
    { consequentialOutput: true }
  ));
test('wrong served identity halts and preserves full reservation plus attribution', async () =>
  setup(
    async (s, seen, ledger) => {
      await expect(s.run(packet(), principal)).rejects.toThrow('provider_identity_or_completion');
      expect(ledger.total()).toBeGreaterThan(10_000);
      expect(JSON.stringify(ledger.snapshot())).toContain('unrequested-model');
      await expect(s.run(packet(), principal)).rejects.toThrow('campaign_halted');
      expect(seen).toHaveLength(1);
    },
    { badIdentity: true }
  ));
test('successful advice persists the original packet, identity, receipt and cited brief', async () =>
  setup(async (s, _seen, ledger) => {
    const p = packet();
    await s.run(p, principal);
    const snapshot = JSON.stringify(ledger.snapshot());
    expect(snapshot).toContain(p.evidence[0].url);
    expect(snapshot).toContain('OpenAI');
    expect(snapshot).toContain('total_cost');
    expect(snapshot).toContain('served_model');
    expect(snapshot).toContain('evidence_ids');
  }));
test('neutral task with consequential evidence still requires independent Sol', async () =>
  setup(async (s, seen) => {
    const p = packet();
    p.evidence[0].content = 'Production readiness is disputed; authority and custody are unclear.';
    await s.run(p, principal);
    expect(seen).toHaveLength(2);
  }));
test('unverified receipt retains full reservation and halts shared campaign', async () =>
  setup(
    async (s, seen, ledger) => {
      await expect(s.run(packet(), principal)).rejects.toThrow('provider_receipt_mismatch');
      expect(ledger.total()).toBeGreaterThan(10_000);
      await expect(s.run(packet(), principal)).rejects.toThrow('campaign_halted');
      expect(seen).toHaveLength(1);
    },
    { badReceipt: true }
  ));
test('routine calls Terra only; no opinion executes an action', async () =>
  setup(async (s, seen) => {
    const out = await s.run(packet(), principal);
    expect(out.status).toBe('advisory_complete');
    expect(out.advice_only).toBe(true);
    expect(seen.map(r => r.model)).toEqual(['openai/gpt-6.1-terra']);
  }));
test('consequential task cannot hide behind routine category; Sol sees no Terra output', async () =>
  setup(async (s, seen) => {
    const out = await s.run(packet('Recommend whether we should merge this PR'), principal);
    expect(out.status).toBe('advisory_complete');
    expect(seen.map(r => r.model)).toEqual(['openai/gpt-6.1-terra', 'openai/gpt-6.1-sol']);
    expect(JSON.stringify(seen[1])).not.toContain('TERRA_SECRET_OPINION');
    expect(seen[0].input).toEqual(seen[1].input);
  }));
test('untrusted citation blocks completion without a paid retry', async () =>
  setup(
    async (s, seen) => {
      await expect(s.run(packet(), principal)).rejects.toThrow('invalid_brief');
      expect(seen).toHaveLength(1);
    },
    { badCitation: true }
  ));
test('unknown charge stops shared campaign; no fallback', async () =>
  setup(
    async (s, seen, ledger) => {
      await expect(s.run(packet(), principal)).rejects.toThrow('unknown_charge');
      await expect(s.run(packet(), principal)).rejects.toThrow('campaign_halted');
      expect(seen).toHaveLength(1);
      expect(ledger.total()).toBeGreaterThan(0);
    },
    { unknown: true }
  ));
test('lease change between legs blocks Sol and leaves an incomplete result', async () =>
  setup(
    async (s, seen) => {
      await expect(s.run(packet('Review deployment readiness'), principal)).rejects.toThrow(
        'stale_xo_lease'
      );
      expect(seen).toHaveLength(1);
    },
    { moveLease: true }
  ));
test('stale packet, held-out URL and wrong principal fail before any provider call', async () =>
  setup(async (s, seen) => {
    await expect(
      s.run({ ...packet(), captured_at: '2020-01-01T00:00:00Z' }, principal)
    ).rejects.toThrow();
    const held = packet();
    held.evidence[0].url = 'https://github.com/thinmansoftware/bdc-harness/blob/dev/held-out/DUMMY';
    await expect(s.run(held, principal)).rejects.toThrow();
    await expect(s.run(packet(), { ...principal, principal_id: 'other' })).rejects.toThrow();
    expect(seen).toHaveLength(0);
  }));
