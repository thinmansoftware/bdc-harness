import { parse } from 'yaml';
import { z } from 'zod';
import { verifyRunnerStepBody } from './evidence-repair-body';
import { verifyRepairInvocation, type RepairInvocation } from './evidence-repair-invocation';

export interface EvidenceRepairRequest {
  readonly repository: string;
  readonly repositoryId: number;
  readonly pr: number;
  readonly repairHead: string;
  readonly originalCheckId: number;
  readonly newCheckId: number;
  readonly publishedBody: string;
}
export interface EvidenceRepairReader {
  readonly json: (path: string) => Promise<unknown>;
  readonly text: (path: string) => Promise<string>;
  readonly localHead: () => Promise<string>;
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repo = z.object({ id, full_name: z.string().optional() });
const step = z.object({
  number: id,
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const jobSchema = z.object({
  id,
  run_id: id,
  run_attempt: id,
  head_sha: sha,
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  check_run_url: z.string(),
  steps: z.array(step),
});
const checkSchema = z.object({
  id,
  name: z.string(),
  app: z.object({ id }),
  head_sha: sha,
  status: z.string(),
  conclusion: z.string().nullable(),
  check_suite: z.object({ id }),
  details_url: z.string(),
});
const runSchema = z.object({
  id,
  run_attempt: id,
  workflow_id: id,
  path: z.string(),
  head_sha: sha,
  event: z.string(),
  repository: repo,
  check_suite_id: id,
  pull_requests: z.array(
    z.object({ number: id, head: z.object({ sha, repo }), base: z.object({ sha, repo }) })
  ),
  referenced_workflows: z.array(z.object({ path: z.string(), sha })),
});
const contentSchema = z.object({ encoding: z.literal('base64'), content: z.string() });
const commitSchema = z.object({ sha, parents: z.array(z.object({ sha })) });
const prSchema = z.object({
  number: id,
  state: z.literal('open'),
  head: z.object({ sha, repo }),
  base: z.object({ repo }),
  body: z.string(),
});
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('shape');
  return value as Record<string, unknown>;
};
const unique = <T>(items: readonly T[]): T => {
  if (items.length !== 1) throw Error('ambiguous');
  const item = items[0];
  if (item === undefined) throw Error('missing');
  return item;
};
const requireEqual = (actual: unknown, expected: unknown): void => {
  if (actual !== expected) throw Error('identity');
};

/** Only supports the independently reviewed Linux runner/reusable-validator path.
 * Every read is read-only. Exceptions are deliberately collapsed: logs and API
 * failures can contain PR content or signed URLs and must not enter run output.
 */
export async function collectEvidenceRepairReceipt(
  request: EvidenceRepairRequest,
  reader: EvidenceRepairReader
): Promise<
  | {
      state: 'verified';
      utf8Bytes: number;
      sha256: string;
      runId: number;
      attempt: number;
      checkId: number;
    }
  | { state: 'unknown'; reason: string }
> {
  try {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)) throw Error('repo');
    id.parse(request.repositoryId);
    id.parse(request.pr);
    sha.parse(request.repairHead);
    id.parse(request.originalCheckId);
    id.parse(request.newCheckId);
    const root = `repos/${request.repository}`;
    const content = async (path: string): Promise<string> => {
      const result = contentSchema.parse(await reader.json(path));
      return Buffer.from(result.content, 'base64').toString('utf8');
    };
    const checkout = async (job: number, number: number): Promise<string> => {
      const log = await reader.text(`${root}/actions/jobs/${job}/steps/${number}/logs`);
      const pattern =
        /^\d{4}-\d{2}-\d{2}T[^\n]+Z \[command\]\/usr\/bin\/git log -1 --format=%H\n\d{4}-\d{2}-\d{2}T[^\n]+Z ([a-f0-9]{40})\n/gm;
      return unique([...log.matchAll(pattern)].flatMap(match => (match[1] ? [match[1]] : [])));
    };
    const load = async (
      checkId: number
    ): Promise<{ invocation: RepairInvocation; baseSha: string; runScript: string }> => {
      const check = checkSchema.parse(await reader.json(`${root}/check-runs/${checkId}`));
      requireEqual(check.id, checkId);
      requireEqual(check.app.id, 15368);
      requireEqual(check.head_sha, request.repairHead);
      requireEqual(check.status, 'completed');
      requireEqual(check.name, 'manifest-validate / manifest-validate');
      const url = new URL(check.details_url);
      requireEqual(url.origin, 'https://github.com');
      const prefix = `/${request.repository}/actions/runs/`;
      if (!url.pathname.startsWith(prefix) || url.search || url.hash) throw Error('details');
      const match = /^([0-9]+)\/job\/([0-9]+)$/.exec(url.pathname.slice(prefix.length));
      if (!match) throw Error('details');
      const jobId = id.parse(Number(match[2]));
      const job = jobSchema.parse(await reader.json(`${root}/actions/jobs/${jobId}`));
      requireEqual(job.id, jobId);
      requireEqual(job.run_id, Number(match[1]));
      requireEqual(job.check_run_url, `https://api.github.com/${root}/check-runs/${checkId}`);
      requireEqual(job.head_sha, request.repairHead);
      requireEqual(job.status, 'completed');
      requireEqual(job.name, check.name);
      requireEqual(job.conclusion, check.conclusion);
      const run = runSchema.parse(
        await reader.json(`${root}/actions/runs/${job.run_id}/attempts/${job.run_attempt}`)
      );
      requireEqual(run.id, job.run_id);
      requireEqual(run.run_attempt, job.run_attempt);
      requireEqual(run.repository.id, request.repositoryId);
      requireEqual(run.repository.full_name, request.repository);
      requireEqual(run.check_suite_id, check.check_suite.id);
      requireEqual(run.event, 'pull_request');
      requireEqual(run.head_sha, request.repairHead);
      const target = unique(run.pull_requests);
      requireEqual(target.number, request.pr);
      requireEqual(target.head.sha, request.repairHead);
      requireEqual(target.head.repo.id, request.repositoryId);
      requireEqual(target.base.repo.id, request.repositoryId);
      if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(run.path)) throw Error('caller');
      const callerSource = await content(`${root}/contents/${run.path}?ref=${request.repairHead}`);
      const caller = record(parse(callerSource));
      const pull = record(record(caller.on).pull_request);
      if (!Array.isArray(pull.types) || !pull.types.includes('edited'))
        throw Error('unsupported_caller');
      const referenced = unique(
        run.referenced_workflows.filter(item =>
          item.path.startsWith('thinmansoftware/bdc-ci/.github/workflows/manifest-validate.yml@')
        )
      );
      const calls = Object.values(record(caller.jobs))
        .map(record)
        .filter(
          item =>
            String(item.uses).replace(
              /^bluedevilcollectibles\/bdc-ci\//,
              'thinmansoftware/bdc-ci/'
            ) === referenced.path
        );
      unique(calls);
      const reusable = record(
        parse(
          await content(
            `repos/thinmansoftware/bdc-ci/contents/.github/workflows/manifest-validate.yml?ref=${referenced.sha}`
          )
        )
      );
      const definition = record(record(reusable.jobs)['manifest-validate']);
      if (!Array.isArray(definition.steps)) throw Error('steps');
      const definitionSteps = definition.steps.map(record);
      const validation = unique(
        definitionSteps.filter(item => item.name === 'Validate manifest v2 block')
      );
      const environment = record(validation.env);
      requireEqual(environment.PR_BODY, '${{ github.event.pull_request.body }}');
      requireEqual(
        environment.GREP_RUNNER,
        '${{ github.workspace }}/.bdc-ci/scripts/run-grep-assertions.sh'
      );
      const scripts = unique(
        definitionSteps.filter(item => item.name === 'Checkout bdc-ci scripts')
      );
      const scriptsWith = record(scripts.with);
      if (
        !['thinmansoftware/bdc-ci', 'bluedevilcollectibles/bdc-ci'].includes(
          String(scriptsWith.repository)
        )
      )
        throw Error('scripts');
      requireEqual(scriptsWith.path, '.bdc-ci');
      const findStep = (name: string): z.infer<typeof step> =>
        unique(job.steps.filter(item => item.name === name));
      const validationStep = findStep('Validate manifest v2 block');
      const sourceStep = findStep('Checkout caller repo');
      const scriptsStep = findStep('Checkout bdc-ci scripts');
      for (const checked of [sourceStep, scriptsStep]) {
        requireEqual(checked.status, 'completed');
        requireEqual(checked.conclusion, 'success');
      }
      requireEqual(validationStep.status, 'completed');
      const checkoutSha = await checkout(jobId, sourceStep.number);
      const scriptsSha = await checkout(jobId, scriptsStep.number);
      requireEqual(await content(`${root}/contents/${run.path}?ref=${checkoutSha}`), callerSource);
      const commit = commitSchema.parse(await reader.json(`${root}/git/commits/${checkoutSha}`));
      requireEqual(commit.sha, checkoutSha);
      const invocation: RepairInvocation = {
        repositoryId: request.repositoryId,
        repository: request.repository,
        pr: request.pr,
        head: request.repairHead,
        runId: run.id,
        attempt: run.run_attempt,
        workflowId: run.workflow_id,
        jobId,
        checkId,
        checkName: check.name,
        appId: check.app.id,
        event: run.event,
        checkConclusion: check.conclusion ?? 'unknown',
        stepConclusion: validationStep.conclusion ?? 'unknown',
        callerSha: run.head_sha,
        reusableSha: referenced.sha,
        scriptsSha,
        checkoutSha,
        checkoutParents: commit.parents.map(parent => parent.sha),
        stepNumber: validationStep.number,
        stepName: validationStep.name,
      };
      return { invocation, baseSha: target.base.sha, runScript: z.string().parse(validation.run) };
    };
    const original = await load(request.originalCheckId);
    const current = await load(request.newCheckId);
    requireEqual(current.baseSha, original.baseSha);
    const finalPR = prSchema.parse(await reader.json(`${root}/pulls/${request.pr}`));
    requireEqual(finalPR.number, request.pr);
    requireEqual(finalPR.head.repo.id, request.repositoryId);
    requireEqual(finalPR.base.repo.id, request.repositoryId);
    requireEqual(finalPR.body, request.publishedBody);
    const identity = verifyRepairInvocation(original.invocation, current.invocation, {
      repairHead: request.repairHead,
      baseSha: current.baseSha,
      finalLocalHead: await reader.localHead(),
      finalRemoteHead: finalPR.head.sha,
      callerSha: original.invocation.callerSha,
      reusableSha: original.invocation.reusableSha,
      scriptsSha: original.invocation.scriptsSha,
    });
    if (identity.state !== 'verified') return identity;
    const name = request.repository.split('/')[1] ?? '';
    const workspace = `/home/runner/work/${name}/${name}`;
    const validationLog = await reader.text(
      `${root}/actions/jobs/${current.invocation.jobId}/steps/${current.invocation.stepNumber}/logs`
    );
    const proof = verifyRunnerStepBody({
      stepLog: validationLog,
      publishedBody: request.publishedBody,
      verifiedRunScript: current.runScript.replaceAll('${{ github.workspace }}', workspace),
      verifiedGrepRunner: `${workspace}/.bdc-ci/scripts/run-grep-assertions.sh`,
    });
    if (proof.state !== 'verified') return proof;
    // Supported validator serialization has an executed terminal summary and
    // closing separator. A preamble-only or cut-off download is not a receipt.
    if (
      !/(?:^|\n)\d{4}-\d{2}-\d{2}T[^\n]+Z RESULT: PASS \([1-9][0-9]* checks passed\)\n\d{4}-\d{2}-\d{2}T[^\n]+Z ={5,}\n$/.test(
        validationLog.slice(proof.inputEndOffset)
      )
    ) {
      return { state: 'unknown', reason: 'validation_log_incomplete' };
    }
    const terminalPR = prSchema.parse(await reader.json(`${root}/pulls/${request.pr}`));
    requireEqual(terminalPR.number, request.pr);
    requireEqual(terminalPR.head.repo.id, request.repositoryId);
    requireEqual(terminalPR.base.repo.id, request.repositoryId);
    requireEqual(terminalPR.head.sha, request.repairHead);
    requireEqual(terminalPR.body, request.publishedBody);
    requireEqual(await reader.localHead(), request.repairHead);
    return {
      ...proof,
      runId: current.invocation.runId,
      attempt: current.invocation.attempt,
      checkId: current.invocation.checkId,
    };
  } catch {
    return { state: 'unknown' as const, reason: 'repair_receipt_unavailable_or_unbound' };
  }
}
