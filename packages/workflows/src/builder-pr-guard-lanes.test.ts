import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { dagNodeSchema } from './schemas/dag-node';

const directory = join(import.meta.dir, '../../../.archon/workflows/defaults');
const prohibition = 'Do NOT open, merge, or mark ready any pull request';

test('every active feature lane guards its schema-parsed builder nodes', () => {
  const names = readdirSync(directory).filter(name =>
    /^bdc-feature-development(?:-.*)?\.yaml$/.test(name)
  );
  expect(names.length).toBeGreaterThanOrEqual(13);
  for (const name of names) {
    const lane = parse(readFileSync(join(directory, name), 'utf8')) as {
      nodes: Record<string, unknown>[];
    };
    for (const id of ['implement', 'diff-repair', 'opus-repair']) {
      const raw = lane.nodes.find(node => node.id === id);
      expect(raw, `${name}/${id}`).toBeDefined();
      const node = dagNodeSchema.parse(raw);
      expect(node.deny_pull_request_mutations, `${name}/${id}`).toBe(true);
      const prompt = 'loop' in node ? node.loop.prompt : 'prompt' in node ? node.prompt : '';
      expect(prompt, `${name}/${id}`).toContain(prohibition);
    }
    for (const node of lane.nodes.filter(node =>
      ['open-pr-if-needed', 'noninteractive-salvage'].includes(String(node.id))
    )) {
      expect(node.deny_pull_request_mutations, `${name}/${String(node.id)}`).toBeUndefined();
    }
  }
});
