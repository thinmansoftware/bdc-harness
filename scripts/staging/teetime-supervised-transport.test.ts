import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readObservationLine, forwardSupervisedLauncher } from './teetime-supervised-transport';
import * as transport from './teetime-supervised-transport';

function channel() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  return {
    reader: stream.getReader(),
    write: (raw: string | Buffer) => controller.enqueue(Buffer.from(raw)),
    end: () => controller.close(),
  };
}
const nonce = 'a'.repeat(32);
const summary = {
  passed: true,
  cleanupVerified: true,
  modelInvocations: 1,
  artifactHash: 'b'.repeat(64),
  candidateVerified: true,
};

test('minimal diagnostic transport has a separate nullable summary and original raw frames',async()=>{
  const input=channel(); const diagnostic={passed:false,cleanupVerified:true,proxyMetricsVerified:true,modelInvocations:null};
  const result=await transport.forwardMinimalDiagnosticLauncher({reader:input.reader,nonce,
    deadlineMs:performance.now()+400000,
    spawn:()=>Bun.spawn([process.execPath,'--no-env-file','-e',
      `console.log(JSON.stringify({type:'READY',nonce:'${nonce}'}));
      await new Response(Bun.stdin.stream()).arrayBuffer();
      console.log(JSON.stringify({type:'RESULT',nonce:'${nonce}',passed:false}));process.exitCode=1;`],
      {stdin:'pipe',stdout:'pipe',stderr:'ignore'}),
    validateReady:async()=>{},emitReady:()=>{input.write(Buffer.from([0,0,0,1,42]));input.end();},
    validateReport:async raw=>{expect(JSON.parse(raw.toString()).exitCode).toBe(1);return diagnostic;}});
  expect(result.summary).toBe(diagnostic);expect(result.summary.modelInvocations).toBeNull();
  expect('artifactHash' in result.summary).toBe(false);expect(result.exitCode).toBe(1);
});

test('minimal diagnostic rejects insufficient or invalid budget before spawn',async()=>{
  for(const deadline of [0,performance.now()+314000,Infinity,NaN,performance.now()+500000]){
    const input=channel();let spawned=false;
    await expect(transport.forwardMinimalDiagnosticLauncher({reader:input.reader,nonce,deadlineMs:deadline,
      spawn:()=>{spawned=true;throw new Error('must not spawn');},
      validateReady:async()=>{},emitReady:()=>{},validateReport:async()=>({passed:false,
        cleanupVerified:false,proxyMetricsVerified:false,modelInvocations:null})})).rejects.toThrow();
    expect(spawned).toBe(false);await input.reader.cancel();
  }
});

test('minimal diagnostic line bound is smaller than unchanged legacy artifact framing',async()=>{
  const input=channel();let emitted=false,validated=false;
  await expect(transport.forwardMinimalDiagnosticLauncher({reader:input.reader,nonce,deadlineMs:performance.now()+400000,
    spawn:()=>Bun.spawn([process.execPath,'--no-env-file','-e',
      `console.log(JSON.stringify({type:'READY',nonce:'${nonce}',padding:'x'.repeat(32768)}));`],
      {stdin:'pipe',stdout:'pipe',stderr:'ignore'}),
    validateReady:async()=>{validated=true;},emitReady:()=>{emitted=true;},
    validateReport:async()=>({passed:false,cleanupVerified:false,proxyMetricsVerified:false,modelInvocations:null})
  })).rejects.toThrow();
  expect(validated).toBe(false);expect(emitted).toBe(false);
});

test('minimal diagnostic does not reset its deadline or send credentials after slow READY validation',async()=>{
  let now=0,emitted=false;const clock=spyOn(performance,'now').mockImplementation(()=>now);
  const input=channel();let reaped=false;
  try {
    await expect(transport.forwardMinimalDiagnosticLauncher({reader:input.reader,nonce,deadlineMs:400000,
      spawn:()=>{
        const process=Bun.spawn([Bun.which('bun')!,'--no-env-file','-e',
          `console.log(JSON.stringify({type:'READY',nonce:'${nonce}'}));await Bun.sleep(60000);`],
          {stdin:'pipe',stdout:'pipe',stderr:'ignore'});
        void process.exited.then(()=>{reaped=true;});return process;},
      validateReady:async()=>{now=390001;},emitReady:()=>{emitted=true;},
      validateReport:async()=>({passed:false,cleanupVerified:false,proxyMetricsVerified:false,modelInvocations:null})
    })).rejects.toThrow('deadline');
    expect(emitted).toBe(false);expect(reaped).toBe(true);
  } finally {clock.mockRestore();}
});

test('fragmented observation remains separate from later credential framing', async () => {
  const input = channel();
  const observed = readObservationLine(input.reader);
  input.write('{"ver');
  input.write('sion":1}\n');
  expect((await observed).toString()).toBe('{"version":1}');
  input.write(Buffer.from([0, 0, 0, 1, 42]));
  input.end();
  expect(Array.from((await input.reader.read()).value!)).toEqual([0, 0, 0, 1, 42]);
});
test('observation rejects pre-READY credentials, missing newline and oversize', async () => {
  for (const bytes of [Buffer.from('{}\nx'), Buffer.alloc(65538, 32), Buffer.from('{}')]) {
    const input = channel();
    input.write(bytes);
    input.end();
    await expect(readObservationLine(input.reader)).rejects.toThrow();
  }
});

test('actual child READY is validated before auth, report waits for exit and validation', async () => {
  const input = channel();
  const order: string[] = [];
  const code = `console.log(JSON.stringify({type:'READY',nonce:'${nonce}'}));
const bytes = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
if (bytes.length !== 5 || bytes[4] !== 42) process.exit(2);
console.log(JSON.stringify({type:'RESULT',nonce:'${nonce}',passed:true}));`;
  const result = await forwardSupervisedLauncher({
    reader: input.reader,
    nonce,
    spawn: () =>
      Bun.spawn([process.execPath, '--no-env-file', '-e', code], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      }),
    validateReady: async () => {
      order.push('validated');
    },
    emitReady: () => {
      order.push('emitted');
      input.write(Buffer.from([0, 0, 0, 1, 42]));
      input.end();
    },
    validateReport: async raw => {
      const value = JSON.parse(raw.toString());
      expect(value.exitCode).toBe(0);
      expect(value.ready.type).toBe('READY');
      expect(value.report.type).toBe('RESULT');
      order.push('report');
      return summary;
    },
  });
  expect(order).toEqual(['validated', 'emitted', 'report']);
  expect(result.summary).toBe(summary);
  expect(result.exitCode).toBe(0);
});

test('repeated or unvalidated READY cannot reach report validation', async () => {
  for (const duplicate of [false, true]) {
    const input = channel();
    let validations = 0;
    const code = `console.log(JSON.stringify({type:'READY',nonce:'${nonce}'}));
console.log(JSON.stringify({type:'READY',nonce:'${nonce}'}));`;
    await expect(
      forwardSupervisedLauncher({
        reader: input.reader,
        nonce,
        spawn: () =>
          Bun.spawn([process.execPath, '--no-env-file', '-e', code], {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'ignore',
          }),
        validateReady: async () => {
          if (!duplicate) throw new Error('wrong package');
        },
        emitReady: () => {
          input.write(Buffer.from([0, 0, 0, 1, 42]));
          input.end();
        },
        validateReport: async () => {
          validations++;
          return summary;
        },
      })
    ).rejects.toThrow();
    expect(validations).toBe(0);
  }
});

test('missing completion or nonzero child cannot become verified success', async () => {
  const input = channel();
  let validations = 0;
  await expect(
    forwardSupervisedLauncher({
      reader: input.reader,
      nonce,
      spawn: () =>
        Bun.spawn([process.execPath, '--no-env-file', '-e', 'process.exit(1)'], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        }),
      validateReady: async () => {},
      emitReady: () => {},
      validateReport: async () => {
        validations++;
        return summary;
      },
    })
  ).rejects.toThrow();
  expect(validations).toBe(0);
});

test('launcher exit after READY settles even while upstream never sends EOF', async () => {
  const input = channel();
  const began = Date.now();
  await expect(
    forwardSupervisedLauncher({
      reader: input.reader,
      nonce,
      spawn: () =>
        Bun.spawn(
          [
            process.execPath,
            '--no-env-file',
            '-e',
            `console.log(JSON.stringify({type:'READY',nonce:'${nonce}'}));`,
          ],
          { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' }
        ),
      validateReady: async () => {},
      emitReady: () => {},
      validateReport: async () => summary,
    })
  ).rejects.toThrow();
  expect(Date.now() - began).toBeLessThan(4000);
});

test('original duplicate RESULT keys reach the independent strict JSON parser', async () => {
  const input = channel();
  let checked = false;
  const code = `console.log(JSON.stringify({type:'READY',nonce:'${nonce}'}));
await new Response(Bun.stdin.stream()).arrayBuffer();
console.log('{"type":"RESULT","nonce":"${nonce}","passed":false,"passed":true}');`;
  await expect(
    forwardSupervisedLauncher({
      reader: input.reader,
      nonce,
      spawn: () =>
        Bun.spawn([process.execPath, '--no-env-file', '-e', code], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        }),
      validateReady: async () => {},
      emitReady: () => {
        input.write(Buffer.from([0, 0, 0, 1, 42]));
        input.end();
      },
      validateReport: async raw => {
        checked = true;
        execFileSync(
          process.platform === 'win32' ? 'python' : 'python3',
          [
            '-I',
            '-c',
            'import sys;sys.path.insert(0,sys.argv[1]);from teetime_joined_fixture import strict_json;strict_json(sys.stdin.buffer.read())',
            import.meta.dirname,
          ],
          { input: raw, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
        );
        return summary;
      },
    })
  ).rejects.toThrow();
  expect(checked).toBe(true);
});

test('uncertain cancellation cannot skip child reaping', async () => {
  const input = channel();
  let cancelling = false;
  let reapingObserved = false;
  const reader = {
    read: () => input.reader.read(),
    cancel: () => {
      cancelling = true;
      void input.reader.cancel();
      return new Promise<void>(() => {});
    },
  };
  await expect(
    forwardSupervisedLauncher({
      reader,
      nonce,
      spawn: () => {
        const child = Bun.spawn([process.execPath, '--no-env-file', '-e', 'process.exit(1)'], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'ignore',
        });
        return new Proxy(child, {
          get(target, property) {
            if (property === 'exited' && cancelling) reapingObserved = true;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      validateReady: async () => {},
      emitReady: () => {},
      validateReport: async () => summary,
    })
  ).rejects.toThrow('cleanup uncertain');
  expect(reapingObserved).toBe(true);
});
