// Runtime-only workflow helper. No fire, CI rerun or caller mutation capability.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { evidenceRepairLane } from '../packages/workflows/src/reliability/evidence-repair-lane';
const exec = promisify(execFile);
const [stage, input, bodyFile] = process.argv.slice(2);
const artifacts = process.env.ARTIFACTS_DIR;
if (!stage || !input || !artifacts) {
  console.log(
    JSON.stringify({ state: 'unknown', operator_handoff: 'evidence_repair_arguments_missing' })
  );
  process.exit(0);
}
const run = async (command: string, args: readonly string[]): Promise<string> => {
  const result = await exec(command, [...args], {
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'buffer',
  });
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
};
const artifact = (name: string): string => {
  const path = resolve(artifacts, name);
  const rel = relative(resolve(artifacts), path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw Error('artifact_path');
  return path;
};
const deps = {
  json: async (path: string): Promise<unknown> =>
    JSON.parse(await run('gh', ['api', path])) as unknown,
  text: async (path: string): Promise<string> => run('gh', ['api', path]),
  git: async (args: readonly string[]): Promise<string> => run('git', args),
  localHead: async (): Promise<string> => (await run('git', ['rev-parse', 'HEAD'])).trim(),
  read: async (name: string): Promise<string> => {
    // Publication identity is substituted from the engine's persisted node output,
    // never recovered from a model-writable node-out artifact.
    if (stage === 'verify' && name === 'node-out/patch-pr-body.out') {
      if (bodyFile === undefined) throw Error('publication_output_missing');
      return bodyFile;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(artifact(name)));
  },
  write: async (name: string, value: string): Promise<void> =>
    writeFile(artifact(name), value, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
};
let result = await evidenceRepairLane(stage, input, deps, bodyFile);
// Observe the normal publication-triggered invocation only; never dispatch or rerun.
for (let attempt = 0; stage === 'verify' && result.state === 'pending' && attempt < 12; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10000));
  result = await evidenceRepairLane(stage, input, deps, bodyFile);
}
console.log(
  JSON.stringify(
    result.state === 'pending'
      ? { state: 'unknown', operator_handoff: 'evidence_repair_check_timeout' }
      : result
  )
);
