/** Explicit read-only provider reconciliation. No new generation or request replay. */
import { homedir } from 'os';
import { join, resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { z } from '@hono/zod-openapi';
import { AdviceLedger } from './ledger';

const root = join(homedir(), 'Downloads', 'terra-xo-lane-approval-20261031');
const file = join(root, 'XO-STAGING-PILOT.sqlite');
if (!existsSync(file)) throw new Error('existing_pilot_ledger_required');
const ledger = new AdviceLedger(file);
const reconciled: unknown[] = [];
try {
  const calls = z
    .array(
      z.object({
        request_id: z.string(),
        leg: z.number(),
        actual: z.number().nullable(),
        started: z.number(),
        attribution: z.string().nullable(),
      })
    )
    .parse(ledger.snapshot().calls);
  for (const call of calls.filter(c => c.started === 1 && c.actual === null && c.attribution)) {
    const recorded = z
      .object({ generation_id: z.string().regex(/^gen-[A-Za-z0-9_-]+$/) })
      .parse(JSON.parse(call.attribution ?? '{}'));
    const child = Bun.spawn(['python', resolve('scripts/staging/xo-advice-relay.py')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(JSON.stringify({ path: 'generation?id=' + recorded.generation_id }));
    child.stdin.end();
    const text = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    if ((await child.exited) || error.trim())
      throw new Error('reconciliation_metadata_read_failed');
    const result = z
      .object({
        status: z.literal(200),
        body: z.object({
          data: z.object({
            id: z.string(),
            model: z.string(),
            provider_name: z.string(),
            total_cost: z.number().finite().nonnegative(),
          }),
        }),
      })
      .parse(JSON.parse(text));
    ledger.reconcileVerifiedCall(call.request_id, call.leg, result.body.data);
    reconciled.push({ request_id: call.request_id, leg: call.leg, receipt: result.body.data });
  }
  const report = {
    at: new Date().toISOString(),
    ledger_path: file,
    reconciled,
    ledger: ledger.snapshot(),
    paid_generations: 0,
    replayed_requests: 0,
    cap_reset: false,
  };
  const output = join(root, 'LATE-RECEIPT-RECONCILIATION-' + Date.now() + '.json');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      reconciled: reconciled.length,
      conservative_debit_usd: ledger.total() / 1_000_000,
      report: output,
    })
  );
} finally {
  ledger.close();
}
