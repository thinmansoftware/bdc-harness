import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  assertCandidateIsCurrentHead,
  validateIndependentReviewEvidence,
  type IndependentReviewArtifact,
} from '../packages/overseer/src/independent-review-evidence';

interface ParentManifest {
  readonly children?: readonly { readonly wo_id?: string; readonly pr_head?: string }[];
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function assertExternalAbsolutePath(path: string, repoRoot: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const absolute = resolve(path);
  const fromRepo = relative(repoRoot, absolute);
  if (fromRepo === '' || (!fromRepo.startsWith('..') && !isAbsolute(fromRepo))) {
    throw new Error(`${label} path must be outside the repository`);
  }
  return absolute;
}

function main(): void {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const manifestPath = resolve(argument('manifest'));
  const artifactPath = assertExternalAbsolutePath(argument('artifact'), repoRoot, 'artifact');
  const transcriptPath = assertExternalAbsolutePath(argument('transcript'), repoRoot, 'transcript');
  const candidateSha = argument('candidate');
  const builderProvider = argument('builder-provider');
  const builderModel = argument('builder-model');
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assertCandidateIsCurrentHead(candidateSha, currentHead);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ParentManifest;
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as IndependentReviewArtifact;
  const rawTranscript = readFileSync(transcriptPath, 'utf8');
  if (!Array.isArray(manifest.children)) throw new Error('manifest children must be an array');

  const childHeads: Record<string, string> = {};
  for (const child of manifest.children) {
    if (!child.wo_id || !child.pr_head) throw new Error('manifest child identity is incomplete');
    if (childHeads[child.wo_id]) throw new Error(`duplicate manifest child: ${child.wo_id}`);
    childHeads[child.wo_id] = child.pr_head;
  }

  const result = validateIndependentReviewEvidence(artifact, rawTranscript, {
    candidate_sha: candidateSha,
    child_heads: childHeads,
    builder: { provider: builderProvider, model: builderModel },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
