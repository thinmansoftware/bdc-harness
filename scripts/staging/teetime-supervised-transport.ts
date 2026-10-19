// One stdin reader carries an observation line, then a bounded credential frame.
// Raw diagnostics and credentials are never logged or retained in a receipt.
import type { Subprocess } from 'bun';

interface InputReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

export async function readObservationLine(reader: InputReader): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done || !item.value) throw new Error('observation input ended');
    const bytes = Buffer.from(item.value);
    size += bytes.length;
    if (size > 65537) throw new Error('observation input bound');
    const newline = bytes.indexOf(10);
    if (newline >= 0) {
      if (newline !== bytes.length - 1) throw new Error('credential input preceded READY');
      parts.push(bytes.subarray(0, newline));
      return Buffer.concat(parts);
    }
    parts.push(bytes);
  }
}

interface ReceiptSummary {
  passed: boolean;
  cleanupVerified: boolean;
  modelInvocations: number;
  artifactHash: string | null;
  candidateVerified: boolean;
}

async function settle<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('transport settlement deadline')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Call only after the durable model claim and provider-attempt readback succeed.
export async function forwardSupervisedLauncher(input: {
  spawn: () => Subprocess<'pipe', 'pipe', 'ignore'>;
  reader: InputReader;
  nonce: string;
  validateReady: (raw: Buffer) => Promise<void>;
  validateReport: (raw: Buffer) => Promise<ReceiptSummary>;
  emitReady: (raw: Buffer) => void;
}): Promise<{ report: Buffer; summary: ReceiptSummary; exitCode: number }> {
  const child = input.spawn();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
    void input.reader.cancel().catch(() => undefined);
  }, 740000);
  // Child exit must unblock an upstream SSH reader that never supplies EOF.
  void child.exited.then(() => input.reader.cancel()).catch(() => undefined);
  let signalReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const readySignal = new Promise<void>((resolve, reject) => {
    signalReady = resolve;
    rejectReady = reject;
  });
  const pump = (async () => {
    await readySignal;
    let total = 0;
    for (;;) {
      const chunk = await input.reader.read();
      if (chunk.done) break;
      if (!chunk.value) throw new Error('credential chunk missing');
      total += chunk.value.length;
      if (total > 65540) throw new Error('credential input bound');
      child.stdin.write(chunk.value);
      await child.stdin.flush();
    }
    if (total < 5) throw new Error('credential frame missing');
    child.stdin.end();
  })();
  // A pump failure must terminate the owned launcher, not wait for its output.
  const pumpFailure = pump.catch(error => {
    child.kill();
    throw error;
  });
  void pumpFailure.catch(() => undefined);
  let ready: Record<string, unknown> | undefined;
  let readyBytes: Buffer | undefined;
  let report: Record<string, unknown> | undefined;
  let reportBytes: Buffer | undefined;
  let pending = Buffer.alloc(0);
  let total = 0;
  try {
    for await (const chunk of child.stdout) {
      total += chunk.length;
      if (total > 196608) throw new Error('launcher total output bound');
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        if (newline > 98304) throw new Error('launcher line output bound');
        const raw = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!raw.length || raw.some(byte => byte > 127))
          throw new Error('launcher ASCII frame required');
        const value = JSON.parse(raw.toString('ascii')) as Record<string, unknown>;
        if (value.nonce !== input.nonce) throw new Error('launcher nonce differs');
        if (!ready && value.type === 'READY') {
          await input.validateReady(raw);
          ready = value;
          readyBytes = Buffer.from(raw);
          input.emitReady(raw);
          signalReady();
        } else if (ready && !report && value.type === 'RESULT') {
          report = value;
          reportBytes = Buffer.from(raw);
        } else throw new Error('unexpected or repeated launcher frame');
      }
      if (pending.length > 98304) throw new Error('launcher line output bound');
    }
    const exitCode = await child.exited;
    if (!ready || !readyBytes || !report || !reportBytes || pending.length || expired)
      throw new Error('launcher completion incomplete');
    await settle(pumpFailure, 3000);
    // Preserve original JSON bytes so Python strict_json sees duplicate keys.
    const summary = await input.validateReport(
      Buffer.concat([
        Buffer.from('{"ready":'),
        readyBytes,
        Buffer.from(',"report":'),
        reportBytes,
        Buffer.from(',"exitCode":' + exitCode + '}'),
      ])
    );
    return { report: reportBytes, summary, exitCode };
  } finally {
    clearTimeout(timer);
    rejectReady(new Error('launcher ended before READY'));
    if (child.exitCode === null) child.kill();
    const cleanup = await Promise.allSettled([
      settle(input.reader.cancel(), 3000),
      settle(
        pumpFailure.catch(() => undefined),
        3000
      ),
      settle(child.exited, 5000),
    ]);
    if (cleanup.some(item => item.status === 'rejected'))
      throw new Error('supervised transport cleanup uncertain');
  }
}
