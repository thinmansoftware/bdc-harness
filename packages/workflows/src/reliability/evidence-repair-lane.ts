import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  collectEvidenceRepairReceipt,
  type EvidenceRepairReader,
} from './evidence-repair-collector';
const hash = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');
const snapshotSchema = z.object({
  state: z.literal('captured'),
  repository: z.string(),
  repositoryId: z.number().int().positive(),
  pr: z.number().int().positive(),
  repairHead: z.string().regex(/^[a-f0-9]{40}$/),
  originalCheckId: z.number().int().positive(),
  originalBodyHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface EvidenceLaneDeps extends EvidenceRepairReader {
  readonly git: (args: readonly string[]) => Promise<string>;
  readonly read: (name: string) => Promise<string>;
  readonly write: (name: string, value: string) => Promise<void>;
}
const handoff = (): { state: 'unknown'; operator_handoff: string } => ({
  state: 'unknown' as const,
  operator_handoff: 'evidence_repair_proof_unavailable',
});
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('shape');
  return value as Record<string, unknown>;
};
const last = (text: string, pattern: RegExp): string => {
  const matches = [...text.matchAll(pattern)];
  return matches.at(-1)?.[1] ?? '';
};
const field = (text: string, key: string): string =>
  last(text, new RegExp('^' + key + '=([^\\r\\n]*)$', 'gm'));
export async function evidenceRepairLane(
  stage: string,
  input: string,
  deps: EvidenceLaneDeps,
  bodyFile?: string
): Promise<{ state: string; [key: string]: unknown }> {
  try {
    if (stage === 'capture') {
      const target = last(input, /^REPAIR_TARGET=#([1-9][0-9]*)$/gm);
      const lease = last(input, /^REPAIR_TARGET_LEASE_SHA=([a-f0-9]{40})$/gm);
      if (!target || !lease) return { state: 'not_applicable' };
      const remote = (await deps.git(['remote', 'get-url', 'origin'])).trim();
      const found =
        /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
          remote
        );
      if (!found) throw Error('remote');
      const metadata = object(await deps.json(`repos/${found[1] ?? ''}`));
      const repository = z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
        .parse(metadata.full_name);
      const root = `repos/${repository}`;
      const pr = object(await deps.json(`${root}/pulls/${target}`));
      const head = object(pr.head);
      const source = object(head.repo);
      if (
        pr.state !== 'open' ||
        pr.number !== Number(target) ||
        head.sha !== lease ||
        source.id !== metadata.id ||
        (await deps.localHead()) !== lease
      )
        throw Error('repair');
      const checks = object(
        await deps.json(`${root}/commits/${lease}/check-runs?filter=all&per_page=100`)
      );
      if (
        !Array.isArray(checks.check_runs) ||
        typeof checks.total_count !== 'number' ||
        checks.total_count > 100 ||
        checks.check_runs.length !== checks.total_count
      )
        throw Error('truncated');
      const failed = checks.check_runs
        .map(object)
        .filter(
          check =>
            check.name === 'manifest-validate / manifest-validate' &&
            object(check.app).id === 15368 &&
            check.head_sha === lease &&
            check.status === 'completed' &&
            check.conclusion === 'failure'
        );
      failed.sort((a, b) => Number(b.id) - Number(a.id));
      const original = failed[0];
      if (!original || typeof pr.body !== 'string') return { state: 'not_applicable' };
      return snapshotSchema.parse({
        state: 'captured',
        repository,
        repositoryId: metadata.id,
        pr: Number(target),
        repairHead: lease,
        originalCheckId: original.id,
        originalBodyHash: hash(pr.body),
      });
    }
    const raw = JSON.parse(input) as unknown;
    if (stage === 'classify') {
      const mailbox = await deps.read('implement.env').catch(() => '');
      const declared = field(mailbox, 'EVIDENCE_ONLY_REPAIR') === 'yes';
      const parsed = snapshotSchema.safeParse(raw);
      if (!declared && !parsed.success) return { state: 'ordinary' };
      if (!parsed.success) return handoff();
      const snapshot = parsed.data;
      const unchanged =
        (await deps.localHead()) === snapshot.repairHead &&
        (await deps.git(['status', '--porcelain'])).trim() === '';
      if (!declared && !unchanged) return { state: 'ordinary' };
      if (
        !declared ||
        !unchanged ||
        field(mailbox, 'COMPLETE') !== 'true' ||
        field(mailbox, 'ALREADY_SATISFIED') !== 'no'
      )
        return handoff();
      const pr = object(await deps.json(`repos/${snapshot.repository}/pulls/${snapshot.pr}`));
      if (
        pr.state !== 'open' ||
        object(pr.head).sha !== snapshot.repairHead ||
        object(object(pr.head).repo).id !== snapshot.repositoryId
      )
        return handoff();
      return {
        state: 'evidence_only',
        prUrl: `https://github.com/${snapshot.repository}/pull/${snapshot.pr}`,
      };
    }
    const snapshot = snapshotSchema.safeParse(raw);
    if (!snapshot.success) return stage === 'verify' ? { state: 'not_applicable' } : handoff();
    if (stage === 'publication') {
      if (!bodyFile) throw Error('body');
      const body = await deps.read(bodyFile);
      if (hash(body) === snapshot.data.originalBodyHash) return handoff();
      const previous = object(
        await deps.json(
          `repos/${snapshot.data.repository}/commits/${snapshot.data.repairHead}/check-runs?filter=all&per_page=100`
        )
      );
      if (
        !Array.isArray(previous.check_runs) ||
        typeof previous.total_count !== 'number' ||
        previous.total_count > 100 ||
        previous.check_runs.length !== previous.total_count
      )
        return handoff();
      const priorCheckIds = previous.check_runs.map(item =>
        z.number().int().positive().parse(object(item).id)
      );
      await deps.write('evidence-repair-published-body', body);
      return { state: 'published', sha256: hash(body), priorCheckIds };
    }
    if (stage === 'terminal') {
      const receipt = object(JSON.parse(bodyFile ?? 'null'));
      const published = await deps.read('evidence-repair-published-body');
      if (
        receipt.state !== 'verified' ||
        receipt.sha256 !== hash(published) ||
        (await deps.git(['status', '--porcelain'])).trim() !== ''
      )
        return handoff();
      const checkId = z.number().int().positive().parse(receipt.checkId);
      const final = await collectEvidenceRepairReceipt(
        { ...snapshot.data, newCheckId: checkId, publishedBody: published },
        deps
      );
      return final.state === 'verified'
        ? final
        : { ...final, operator_handoff: 'evidence_repair_terminal_unavailable' };
    }
    if (stage === 'verify') {
      const mailbox = await deps.read('implement.env').catch(() => '');
      if (field(mailbox, 'EVIDENCE_ONLY_REPAIR') !== 'yes') return { state: 'not_applicable' };
      const published = await deps.read('evidence-repair-published-body');
      const publicationOutput = await deps.read('node-out/patch-pr-body.out');
      const publicationLines = publicationOutput
        .split(/\r?\n/)
        .filter(line => line.startsWith('EVIDENCE_PUBLICATION='));
      if (publicationLines.length !== 1) return handoff();
      const publication = object(
        JSON.parse((publicationLines[0] ?? '').slice('EVIDENCE_PUBLICATION='.length))
      );
      if (
        publication.state !== 'published' ||
        publication.sha256 !== hash(published) ||
        publication.sha256 === snapshot.data.originalBodyHash
      )
        return handoff();
      const checks = object(
        await deps.json(
          `repos/${snapshot.data.repository}/commits/${snapshot.data.repairHead}/check-runs?filter=all&per_page=100`
        )
      );
      if (
        !Array.isArray(checks.check_runs) ||
        typeof checks.total_count !== 'number' ||
        checks.total_count > 100 ||
        checks.check_runs.length !== checks.total_count
      )
        return handoff();
      const priorIds = z.array(z.number().int().positive()).parse(publication.priorCheckIds);
      const candidates = checks.check_runs
        .map(object)
        .filter(
          check =>
            check.name === 'manifest-validate / manifest-validate' &&
            object(check.app).id === 15368 &&
            check.head_sha === snapshot.data.repairHead &&
            typeof check.id === 'number' &&
            !priorIds.includes(check.id)
        );
      candidates.sort((a, b) => Number(b.id) - Number(a.id));
      const selected = candidates[0];
      if (selected?.status !== 'completed') return { state: 'pending' };
      if ((await deps.git(['status', '--porcelain'])).trim() !== '') return handoff();
      const result = await collectEvidenceRepairReceipt(
        { ...snapshot.data, newCheckId: Number(selected.id), publishedBody: published },
        deps
      );
      if (result.state !== 'verified')
        return { ...result, operator_handoff: 'evidence_repair_proof_unavailable' };
      return result;
    }
    return handoff();
  } catch {
    return handoff();
  }
}
