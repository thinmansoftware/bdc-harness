/**
 * Checks a production motion record against the M-09 promotion gate's rules 1 to 6, the way the
 * gate would read it, before anyone opens the promoting pull request (WO-HARNESS-M09-GATE-MOTION-FORMAT-01).
 *
 *   bun run scripts/overseer/check-motion-record.ts <motion-file> <owner/name> <head-sha | tree:TREE>
 *
 * The third argument is what the pull request block would pin: a 40-hex head commit (an
 * `approved_sha` block) or `tree:` and a 40-hex git tree (an `approved_tree` block). Rule 7 (the
 * pull request is not behind its base) needs the live pull request and is not checked here.
 * Exit 0 when the record is readable and rules 1 to 6 pass; exit 1 otherwise; exit 2 on bad usage.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import {
  evaluatePromotion,
  parseMotionRecord,
} from '../../packages/overseer/src/m09-promotion-gate';

const [file, repository, pin] = process.argv.slice(2);
if (!file || !repository || !pin || process.argv.length > 5) {
  console.error('usage: check-motion-record.ts <motion-file> <owner/name> <head-sha | tree:TREE>');
  process.exit(2);
}
const text = readFileSync(file, 'utf8');
const record = parseMotionRecord(text);
console.log(
  `record: ${record.frontMatter ? 'front-matter block' : 'whole-file scan (no front matter)'}`
);
for (const [key, value] of Object.entries(record.fields)) console.log(`field ${key} = ${value}`);
if (record.malformed) console.log(`MALFORMED: ${record.problem}`);
const id = record.fields.motion_id ?? '';
const byTree = pin.startsWith('tree:');
const value = byTree ? pin.slice('tree:'.length) : pin;
const name = basename(file);
const realName = name.startsWith(`${id}-`) && name.endsWith('.md');
if (!realName)
  console.log(
    `note: the file name is ${name}; in bdc-xo it must be docs/board/motions/${id || '<motion_id>'}-<slug>.md ` +
      '(a dot after the id marks a companion file and does not count)'
  );
const result = evaluatePromotion({
  repository,
  head: byTree ? '' : value,
  headTree: byTree ? value : '',
  body: `M-09 promotion:\nmotion_id: ${id}\n${byTree ? 'approved_tree' : 'approved_sha'}: ${value}`,
  // A synthetic pin and listing: the real gate reads bdc-xo main at evaluation time.
  pinnedSha: 'f'.repeat(40),
  truncated: false,
  paths: [`docs/board/motions/${realName ? name : `${id}-record.md`}`],
  motion: text,
  behindBy: 0,
});
for (const rule of result.rules.slice(0, 6))
  console.log(
    `${rule.pass ? 'PASS' : 'FAIL'} ${rule.name}${rule.detail ? ` -- ${rule.detail}` : ''}`
  );
console.log('7 ancestry: not checked here (needs the live pull request)');
if (result.reason) console.log(`reason: ${result.reason}`);
process.exit(!record.malformed && result.rules.slice(0, 6).every(rule => rule.pass) ? 0 : 1);
