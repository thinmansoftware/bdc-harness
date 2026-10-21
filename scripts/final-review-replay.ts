#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  getAgentProvider,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '../packages/providers/src';

interface NodeDef {
  id: string;
  provider?: string;
  model?: string;
  prompt?: string;
}

interface LaneDef {
  provider?: string;
  model?: string;
  nodes?: NodeDef[];
}

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0 || !Bun.argv[index + 1]) throw new Error(`missing ${name}`);
  return Bun.argv[index + 1];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const lanePath = resolve(argument('--lane'));
const fixtureDir = resolve(argument('--fixture'));
const lane = Bun.YAML.parse(readFileSync(lanePath, 'utf8')) as LaneDef;
const node = lane.nodes?.find(candidate => candidate.id === 'diff-review-final');
if (!node?.prompt) throw new Error(`${lanePath}: diff-review-final prompt is missing`);

const providerName = node.provider ?? lane.provider ?? 'claude';
const model = node.model ?? lane.model ?? 'sonnet';
const patch = readFileSync(resolve(fixtureDir, 'diff-final.patch'), 'utf8');
readFileSync(resolve(fixtureDir, 'diff-final.files'), 'utf8');
const spec = readFileSync(resolve(fixtureDir, 'spec.md'), 'utf8');
const headFile = resolve(fixtureDir, 'head.txt');
const head = (await Bun.file(headFile).exists())
  ? readFileSync(headFile, 'utf8').trim()
  : sha256(patch).slice(0, 40);
const capture = [
  `DIFF_FINAL_HEAD=${head}`,
  `DIFF_FINAL_SHA256=${sha256(patch)}`,
  `DIFF_FINAL_FILES=${resolve(fixtureDir, 'diff-final.files')}`,
  `DIFF_FINAL_ARTIFACT=${resolve(fixtureDir, 'diff-final.patch')}`,
].join('\n');

const prompt = node.prompt
  .replaceAll('$read-spec.output', spec)
  .replaceAll('$plan-review.output', 'PLAN_REVIEW_APPROVED')
  .replaceAll('$capture-diff-final.output', capture)
  .replaceAll('$ARTIFACTS_DIR/diff-final.patch', resolve(fixtureDir, 'diff-final.patch'))
  .replaceAll('$ARTIFACTS_DIR/diff-final.files', resolve(fixtureDir, 'diff-final.files'));

registerBuiltinProviders();
registerCommunityProviders();
const provider = getAgentProvider(providerName);
let recording = '';
for await (const chunk of provider.sendQuery(prompt, fixtureDir, undefined, {
  model,
  nodeConfig: { allowed_tools: ['Read', 'Glob', 'Grep'] },
})) {
  if (chunk.type === 'assistant') recording += chunk.content;
}
if (!recording.trim()) throw new Error(`${providerName}/${model} returned no assistant output`);

mkdirSync(fixtureDir, { recursive: true });
writeFileSync(resolve(fixtureDir, 'recording.txt'), recording.trimEnd() + '\n');
const command = `bun scripts/final-review-replay.ts --lane ${lanePath} --fixture ${fixtureDir}`;
writeFileSync(
  resolve(fixtureDir, 'meta.json'),
  JSON.stringify(
    {
      lane: basename(lanePath),
      node: 'diff-review-final',
      provider: providerName,
      model,
      prompt_template_sha256: sha256(node.prompt),
      fixture_patch_sha256: sha256(patch),
      head,
      recorded_at: new Date().toISOString(),
      command,
    },
    null,
    2
  ) + '\n'
);
