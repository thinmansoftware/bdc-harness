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

interface LauncherInput<Summary> {
  spawn: () => Subprocess<'pipe', 'pipe', 'ignore'>;
  reader: InputReader;
  nonce: string;
  validateReady: (raw: Buffer) => Promise<void>;
  validateReport: (raw: Buffer) => Promise<Summary>;
  emitReady: (raw: Buffer) => void;
}

export interface MinimalDiagnosticSummary {
  passed: boolean;
  cleanupVerified: boolean;
  proxyMetricsVerified: boolean;
  modelInvocations: number | null;
}

// Call only after the durable model claim and provider-attempt readback succeed.
export async function forwardSupervisedLauncher(input: LauncherInput<ReceiptSummary>):
Promise<{ report: Buffer; summary: ReceiptSummary; exitCode: number }> {
  return forwardLauncher(input);
}

// Separate closed profile. Deadline is the caller's existing monotonic deadline,
// never a new budget after READY. The same strict Python validators must inspect
// original bytes before either credential forwarding or report acceptance.
export async function forwardMinimalDiagnosticLauncher(
  input: LauncherInput<MinimalDiagnosticSummary> & {deadlineMs: number}
): Promise<{report: Buffer; summary: MinimalDiagnosticSummary; exitCode: number}> {
  const remaining=input.deadlineMs-performance.now();
  if(!Number.isFinite(remaining)||remaining<=315000||remaining>420000)
    throw new Error('closed diagnostic transport budget required');
  return forwardLauncher(input,input.deadlineMs);
}

async function forwardLauncher<Summary>(input: LauncherInput<Summary>, deadlineMs?:number):
Promise<{report:Buffer;summary:Summary;exitCode:number}> {
  const diagnostic=deadlineMs!==undefined;
  const lineBound=diagnostic?32768:98304,totalBound=diagnostic?65536:196608;
  const operationRemaining=()=>deadlineMs!-performance.now()-10000;
  const bounded=async<T>(operation:()=>Promise<T>):Promise<T>=>{
    if(!diagnostic)return operation();
    const ms=operationRemaining();
    if(ms<=0)throw new Error('diagnostic transport deadline');
    const value=await settle(Promise.resolve().then(operation),ms);
    if(operationRemaining()<=0)throw new Error('diagnostic transport deadline');
    return value;
  };
  const child = input.spawn();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    child.kill();
    void input.reader.cancel().catch(() => undefined);
  }, diagnostic ? Math.max(0,operationRemaining()) : 740000);
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
      if (total > totalBound) throw new Error('launcher total output bound');
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline < 0) break;
        if (newline > lineBound) throw new Error('launcher line output bound');
        const raw = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!raw.length || raw.some(byte => byte > 127))
          throw new Error('launcher ASCII frame required');
        const value = JSON.parse(raw.toString('ascii')) as Record<string, unknown>;
        if (value.nonce !== input.nonce) throw new Error('launcher nonce differs');
        if (!ready && value.type === 'READY') {
          await bounded(()=>input.validateReady(raw));
          ready = value;
          readyBytes = Buffer.from(raw);
          input.emitReady(raw);
          signalReady();
        } else if (ready && !report && value.type === 'RESULT') {
          report = value;
          reportBytes = Buffer.from(raw);
        } else throw new Error('unexpected or repeated launcher frame');
      }
      if (pending.length > lineBound) throw new Error('launcher line output bound');
    }
    const exitCode = await child.exited;
    if (!ready || !readyBytes || !report || !reportBytes || pending.length || expired)
      throw new Error('launcher completion incomplete');
    await bounded(()=>settle(pumpFailure, 3000));
    // Preserve original JSON bytes so Python strict_json sees duplicate keys.
    const validationBytes = Buffer.concat([
        Buffer.from('{"ready":'),
        readyBytes,
        Buffer.from(',"report":'),
        reportBytes,
        Buffer.from(',"exitCode":' + exitCode + '}'),
      ]);
    const summary = await bounded(()=>input.validateReport(validationBytes));
    return { report: reportBytes, summary, exitCode };
  } finally {
    clearTimeout(timer);
    rejectReady(new Error('launcher ended before READY'));
    if (child.exitCode === null) child.kill();
    const cleanupBound=(maximum:number)=>diagnostic
      ? Math.max(1,Math.min(maximum,deadlineMs!-performance.now())) : maximum;
    const cleanup = await Promise.allSettled([
      settle(input.reader.cancel(), cleanupBound(3000)),
      settle(
        pumpFailure.catch(() => undefined),
        cleanupBound(3000)
      ),
      settle(child.exited, cleanupBound(5000)),
    ]);
    if (cleanup.some(item => item.status === 'rejected'))
      throw new Error('supervised transport cleanup uncertain');
  }
}
