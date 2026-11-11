/**
 * WO-HARNESS-M09-GATE-MOTION-FORMAT-01: the M-09 gate reads a front-matter motion record, accepts
 * a tree pin, accepts the agreed status tokens and says what it expected when the record is missing.
 *
 * Fixtures (packages/overseer/src/__tests__/fixtures):
 * - deploy-motion-template.md: byte-identical copy of docs/board/templates/deploy-motion.md in
 *   thinmansoftware/bdc-xo at merge commit 5f2b6bfe8e5b5f39e92add6c481f0012e74873e6 (PR 5558).
 * - m-20261111b-head.md: the first twelve lines of the real production motion M-20261111b (title,
 *   Status line and opening paragraphs), the record the first real gate run failed on.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluatePromotion,
  parseMotionRecord,
  promotionBlock,
  scanMotionFile,
  type PromotionInput,
} from '../m09-promotion-gate';
import { createPromotionGate } from '../m09-promotion-gate-wiring';

// A Windows checkout with autocrlf turns the fixtures into CRLF; the tests compare exact LF text.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n');
const TEMPLATE = fixture('deploy-motion-template.md');
const REAL_HEAD = fixture('m-20261111b-head.md');
const repo = 'thinmansoftware/lspro-react';
const ID = 'M-20261112a';
const sha = 'a'.repeat(40);
const tree = 'c'.repeat(40);
const pin = 'b'.repeat(40);

/** The template with its placeholders replaced by test values (status CARRIED). */
function filled(): string {
  return TEMPLATE.replaceAll('M-YYYYMMDDx', ID)
    .replaceAll('owner/name', repo)
    .replaceAll('<40-hex-head-of-the-promoting-PR>', sha)
    .replace('status: TABLED', 'status: CARRIED');
}
function block(over: Record<string, string> = {}): string {
  const fields = {
    motion_id: ID,
    governs: 'M-09',
    repository: repo,
    approved_sha: sha,
    status: 'CARRIED',
    ...over,
  };
  return `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')}\n---\n`;
}
function input(over: Partial<PromotionInput> = {}): PromotionInput {
  return {
    repository: repo,
    head: sha,
    body: `M-09 promotion:\nmotion_id: ${ID}\napproved_sha: ${sha}`,
    pinnedSha: pin,
    truncated: false,
    paths: [`docs/board/motions/${ID}-promotion.md`],
    motion: block(),
    behindBy: 0,
    ...over,
  };
}
const passes = (r: ReturnType<typeof evaluatePromotion>, from: number, to: number): boolean =>
  r.rules.slice(from, to).every(rule => rule.pass);

describe('front matter', () => {
  test('1: the block is read and prose outside it is ignored', () => {
    const text =
      block() +
      '\n# Title\n\nStatus: TABLED for now\nRepository: somewhere else\n| Status | Meaning |\n' +
      'motion_id: M-19990101a\n';
    const record = parseMotionRecord(text);
    expect(record.malformed).toBe(false);
    expect(record.frontMatter).toBe(true);
    expect(record.fields).toEqual({
      motion_id: ID,
      governs: 'M-09',
      repository: repo,
      approved_sha: sha,
      status: 'CARRIED',
    });
    expect(passes(evaluatePromotion(input({ motion: text })), 1, 6)).toBe(true);
    // The whole-file scan, by contrast, is trapped by the same prose.
    expect(scanMotionFile(text).malformed).toBe(true);
  });

  test('1b: unknown keys are ignored whatever they hold; comments, a BOM, CRLF and trailing spaces are fine', () => {
    const bom = String.fromCharCode(0xfeff);
    const text = [
      bom + '---  ',
      '# a comment line',
      '',
      'johns_go: GIVEN 2026-11-12T10:00Z (said so)',
      'patch_id: abc def',
      'motion_id: ' + ID + '  ',
      'governs: M-09',
      'repository: ' + repo,
      'approved_sha: ' + sha,
      'status: CARRIED   ',
      '---',
      'Status: prose after the block',
      '',
    ].join('\r\n');
    const record = parseMotionRecord(text);
    expect(record.malformed).toBe(false);
    expect(record.fields.status).toBe('CARRIED');
    expect(Object.hasOwn(record.fields, 'johns_go')).toBe(false);
    expect(passes(evaluatePromotion(input({ motion: text })), 1, 6)).toBe(true);
  });

  test('2: a record without front matter is read by the whole-file scan exactly as before', () => {
    const legacy = `motion_id: ${ID}\ngoverns: M-09\nrepository: ${repo}\nstatus: CARRIED\napproved_sha: ${sha}`;
    const record = parseMotionRecord(legacy);
    expect(record.frontMatter).toBe(false);
    expect(record.malformed).toBe(false);
    expect(record.fields).toEqual(scanMotionFile(legacy).fields);
    expect(passes(evaluatePromotion(input({ motion: legacy })), 1, 6)).toBe(true);
    // The real M-20261111b header is malformed under the scan (its Status line has prose after the token).
    const real = parseMotionRecord(REAL_HEAD);
    expect(real.frontMatter).toBe(false);
    expect(real.malformed).toBe(true);
    expect(real.problem).toContain('line 3');
  });

  test('3: malformed front matter fails closed, rules 2 to 5 fail', () => {
    const bad = [
      block().replace(/\n---\n$/, '\n'), // no closing line
      block().replace('status: CARRIED', 'status: CARRIED\nstatus: RATIFIED'), // repeated key
      block({ status: 'CARRIED 3-0' }), // two tokens
      block().replace('governs: M-09', 'just some words'), // not key: value
      block({ repository: '' }), // empty value
    ];
    for (const motion of bad) {
      const record = parseMotionRecord(motion);
      expect(record.malformed).toBe(true);
      expect(record.problem).not.toBe('');
      const r = evaluatePromotion(input({ motion }));
      expect(passes(r, 1, 5)).toBe(false);
      expect(r.rules.slice(1, 5).every(rule => !rule.pass)).toBe(true);
      expect(r.conclusion).toBe('failure');
    }
  });

  test('11: the template fixture cannot drift silently', () => {
    const compatible = (text: string): boolean => {
      const record = parseMotionRecord(text);
      const old = scanMotionFile(text);
      const a = evaluatePromotion(input({ motion: text }));
      const b = evaluatePromotion(
        input({ motion: text.replace('---\n', '').replace('\n---\n', '\n') })
      );
      return (
        !record.malformed &&
        !old.malformed &&
        passes(a, 1, 5) &&
        passes(b, 1, 5) &&
        JSON.stringify(record.fields) === JSON.stringify(old.fields)
      );
    };
    expect(TEMPLATE.startsWith('---\nmotion_id: M-YYYYMMDDx\ngoverns: M-09\n')).toBe(true);
    expect(compatible(filled())).toBe(true);
    for (const extra of [
      'status: see below',
      'Repository: x y',
      '| Status | Meaning |',
      'motion_id: M-1',
    ])
      expect(compatible(`${filled()}\n${extra}\n`)).toBe(false);
  });
});

describe('rules', () => {
  test('4: status tokens', () => {
    const verdict: Record<string, boolean> = {
      TABLED: false,
      DRAFT: false,
      CARRIED: true,
      RATIFIED: true,
      CARRIED_WITH_CONDITIONS: true,
      NOT_CARRIED: false,
      PARKED: false,
      EXECUTED: false,
      carried: false,
    };
    for (const [status, pass] of Object.entries(verdict)) {
      const r = evaluatePromotion(input({ motion: block({ status }) }));
      expect(r.rules[4]?.pass).toBe(pass);
      expect(r.reason.includes('carried with conditions: read the motion')).toBe(
        status === 'CARRIED_WITH_CONDITIONS'
      );
    }
  });

  test('5: repository is a comma-separated list; none never matches', () => {
    const verdict: [string, boolean][] = [
      ['thinmansoftware/shopops', false],
      [`thinmansoftware/shopops,${repo}`, true],
      [`${repo},thinmansoftware/shopops`, true],
      ['none', false],
      [repo, true],
      [repo.toUpperCase(), false],
    ];
    for (const [value, pass] of verdict)
      expect(
        evaluatePromotion(input({ motion: block({ repository: value }) })).rules[3]?.pass
      ).toBe(pass);
  });

  test('6: governs is exactly M-09', () => {
    expect(evaluatePromotion(input({ motion: block({ governs: 'M-09' }) })).rules[2]?.pass).toBe(
      true
    );
    expect(evaluatePromotion(input({ motion: block({ governs: 'M-10' }) })).rules[2]?.pass).toBe(
      false
    );
  });

  test('7: approved_tree passes only for the head tree listed in the record', () => {
    const treeBody = `M-09 promotion:\nmotion_id: ${ID}\napproved_tree: ${tree}`;
    const motion = (list: string): string =>
      block().replace(`approved_sha: ${sha}`, `approved_tree: ${list}`);
    const base = { body: treeBody, headTree: tree };
    const ok = evaluatePromotion(
      input({ ...base, motion: motion(`${'d'.repeat(40)},${tree},${'e'.repeat(40)}`) })
    );
    expect(ok.rules[5]).toEqual({ name: '6 approved_tree', pass: true });
    expect(ok.conclusion).toBe('success');
    // The head tree differs from the pinned tree.
    expect(
      evaluatePromotion(input({ ...base, headTree: 'd'.repeat(40), motion: motion(tree) })).rules[5]
        ?.pass
    ).toBe(false);
    // The record does not list the tree.
    expect(
      evaluatePromotion(input({ ...base, motion: motion('d'.repeat(40)) })).rules[5]?.pass
    ).toBe(false);
    // A malformed entry in the list fails the whole rule.
    expect(
      evaluatePromotion(input({ ...base, motion: motion(`${tree},nothex`) })).rules[5]?.pass
    ).toBe(false);
    // The head tree was not read.
    expect(
      evaluatePromotion(input({ ...base, headTree: '', motion: motion(tree) })).rules[5]?.pass
    ).toBe(false);
    // A record that only has approved_sha cannot satisfy an approved_tree block.
    expect(evaluatePromotion(input({ ...base, motion: block() })).rules[5]?.pass).toBe(false);
  });

  test('8: approved_sha is unchanged; a block with both pin lines or neither is not a block', () => {
    expect(evaluatePromotion(input()).rules[5]).toEqual({ name: '6 approved_sha', pass: true });
    expect(evaluatePromotion(input({ head: 'f'.repeat(40) })).rules[5]?.pass).toBe(false);
    expect(
      evaluatePromotion(input({ body: input().body.replace(sha, 'aaaaaaa') })).rules[5]?.pass
    ).toBe(false);
    for (const body of [
      `M-09 promotion:\nmotion_id: ${ID}\napproved_sha: ${sha}\napproved_tree: ${tree}`,
      `M-09 promotion:\nmotion_id: ${ID}\napproved_tree: ${tree}\napproved_sha: ${sha}`,
      `M-09 promotion:\nmotion_id: ${ID}`,
    ]) {
      expect(promotionBlock(body)).toBeNull();
      expect(evaluatePromotion(input({ body })).rules[0]?.pass).toBe(false);
    }
    expect(promotionBlock(`M-09 promotion:\nmotion_id: ${ID}\napproved_tree: ${tree}`)).toEqual({
      id: ID,
      sha: '',
      tree,
    });
  });
});

describe('file-name hint', () => {
  test('9: rule 2 says what it expected when the record is missing or ambiguous', () => {
    const companion = evaluatePromotion(
      input({ paths: [`docs/board/motions/${ID}.votes.md`], motion: '' })
    );
    expect(companion.rules[1]?.pass).toBe(false);
    expect(companion.rules[1]?.detail).toBe(
      `expected docs/board/motions/${ID}-<slug>.md (a dot after the id, as in ${ID}.votes.md, marks a companion and does not count)`
    );
    const two = evaluatePromotion(
      input({
        paths: [`docs/board/motions/${ID}-one.md`, `docs/board/motions/${ID}-two.md`],
        motion: '',
      })
    );
    expect(two.rules[1]?.detail).toContain('2 files match');
    expect(two.rules[1]?.detail).toContain(`${ID}-*.md`);
    const bad = evaluatePromotion(input({ motion: block({ status: 'CARRIED 3-0' }) }));
    expect(bad.rules[1]?.detail).toContain('the record is malformed: block line');
    expect(evaluatePromotion(input()).rules[1]?.detail).toBeUndefined();
  });
});

describe('through the gate', () => {
  function world(opts: { motion: string; body: string; paths?: string[]; headTree?: string }) {
    const reads: string[] = [];
    const writes: { route: string; data: Record<string, unknown> }[] = [];
    let check: { id: number; name: string; external_id: string; app: { id: number } } | undefined;
    const request = async (route: string, data: Record<string, unknown>) => {
      if (route.startsWith('POST') || route.startsWith('PATCH')) {
        writes.push({ route, data });
        check = { id: 1, name: 'm09-promotion-gate', external_id: sha, app: { id: 4574893 } };
        return { data: check };
      }
      reads.push(route);
      if (route.includes('/commits/{commit_sha}/pulls')) return { data: [] };
      if (route.includes('/git/commits/{commit_sha}')) {
        expect(data.commit_sha).toBe(sha);
        return { data: { tree: { sha: opts.headTree ?? tree } } };
      }
      if (route.includes('/pulls/'))
        return { data: { number: 1, body: opts.body, head: { sha }, base: { ref: 'main' } } };
      if (route.includes('/compare/')) return { data: { behind_by: 0 } };
      if (route.includes('/git/ref/')) return { data: { object: { sha: pin } } };
      if (route.includes('/git/trees/'))
        return {
          data: {
            truncated: false,
            tree: (opts.paths ?? [`docs/board/motions/${ID}-promotion.md`]).map(path => ({
              path,
              type: 'blob',
              mode: '100644',
            })),
          },
        };
      if (route.includes('/contents/'))
        return {
          data: { content: Buffer.from(opts.motion).toString('base64'), encoding: 'base64' },
        };
      if (route.includes('/check-runs')) return { data: { check_runs: check ? [check] : [] } };
      throw Error(`unexpected read ${route}`);
    };
    const run = () =>
      createPromotionGate(request, 4574893, { retryDelay: async () => {} })({
        repository: repo,
        number: 1,
        head: sha,
        base: 'main',
      });
    return { reads, writes, run };
  }
  const summary = (w: ReturnType<typeof world>): string =>
    String((w.writes.at(-1)?.data.output as { summary: string }).summary);

  test('7 (wiring): a tree block costs exactly one head-commit read and passes with conditions', async () => {
    const w = world({
      body: `M-09 promotion:\nmotion_id: ${ID}\napproved_tree: ${tree}`,
      motion: block({ status: 'CARRIED_WITH_CONDITIONS' }).replace(
        `approved_sha: ${sha}`,
        `approved_tree: ${'d'.repeat(40)},${tree}`
      ),
    });
    await w.run();
    expect(w.writes.at(-1)?.data.conclusion).toBe('success');
    expect(w.reads.filter(route => route.includes('/git/commits/')).length).toBe(1);
    expect(summary(w)).toContain('carried with conditions: read the motion');
    expect(summary(w)).toMatch(/PASS .* 6 approved_tree/);
  });

  test('7 (wiring): the head tree differs, so the gate fails', async () => {
    const w = world({
      body: `M-09 promotion:\nmotion_id: ${ID}\napproved_tree: ${tree}`,
      motion: block().replace(`approved_sha: ${sha}`, `approved_tree: ${tree}`),
      headTree: 'd'.repeat(40),
    });
    await w.run();
    expect(w.writes.at(-1)?.data.conclusion).toBe('failure');
    expect(summary(w)).toMatch(/FAIL .* 6 approved_tree/);
  });

  test('a head-sha block reads no head commit', async () => {
    const w = world({ body: input().body, motion: block() });
    await w.run();
    expect(w.writes.at(-1)?.data.conclusion).toBe('success');
    expect(w.reads.filter(route => route.includes('/git/commits/')).length).toBe(0);
  });

  test('9 (wiring): the check run text names the expected file when only a companion exists', async () => {
    const w = world({
      body: input().body,
      motion: block(),
      paths: [`docs/board/motions/${ID}.votes.md`],
    });
    await w.run();
    expect(w.writes.at(-1)?.data.conclusion).toBe('failure');
    expect(summary(w)).toContain(`expected docs/board/motions/${ID}-<slug>.md`);
  });
});

describe('check tool', () => {
  const tool = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'overseer',
    'check-motion-record.ts'
  );
  const dir = mkdtempSync(join(tmpdir(), 'm09-record-'));
  const run = (file: string, repository: string, pinned: string) => {
    const r = Bun.spawnSync(['bun', 'run', tool, file, repository, pinned], { cwd: dir });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const write = (name: string, text: string): string => {
    mkdirSync(join(dir, 'motions'), { recursive: true });
    const path = join(dir, 'motions', name);
    writeFileSync(path, text);
    return path;
  };

  test('10: exits 0 for the filled template and for the amended record, 1 for the unmodified record', () => {
    try {
      const template = run(write(`${ID}-template.md`, filled()), repo, sha);
      expect(template.out).toContain('record: front-matter block');
      expect(template.out).toContain('PASS 5 status');
      expect(template.code).toBe(0);

      const amended = run(
        write(
          'M-20261111b-comic-edition.md',
          block({ motion_id: 'M-20261111b', status: 'CARRIED' }) + REAL_HEAD
        ),
        repo,
        sha
      );
      expect(amended.out).toContain('field motion_id = M-20261111b');
      expect(amended.code).toBe(0);

      const byTree = run(
        write(
          'M-20261111b-by-tree.md',
          block({ motion_id: 'M-20261111b' }).replace(
            `approved_sha: ${sha}`,
            `approved_tree: ${tree}`
          ) + REAL_HEAD
        ),
        repo,
        `tree:${tree}`
      );
      expect(byTree.out).toContain('PASS 6 approved_tree');
      expect(byTree.code).toBe(0);

      const unmodified = run(write('M-20261111b-unmodified.md', REAL_HEAD), repo, sha);
      expect(unmodified.out).toContain('MALFORMED: line 3');
      expect(unmodified.code).toBe(1);

      expect(run(write('M-20261111b-x.md', block({ status: 'TABLED' })), repo, sha).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
