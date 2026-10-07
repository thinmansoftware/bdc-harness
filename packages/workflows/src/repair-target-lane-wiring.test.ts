import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon', 'workflows', 'defaults');
const EXPECTED_LANES = [
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development.yaml',
].sort();

interface LaneNode {
  readonly id: string;
  readonly depends_on?: readonly string[];
  readonly bash?: string;
  readonly prompt?: string;
  readonly loop?: { readonly prompt?: string };
}

function nodesFor(file: string): readonly LaneNode[] {
  const result = parse(readFileSync(join(LANES_DIR, file), 'utf8')) as {
    nodes?: readonly LaneNode[];
  };
  if (!result.nodes) throw new Error(`${file}: parse failed`);
  return result.nodes;
}

function node(nodes: readonly LaneNode[], id: string, file: string): LaneNode {
  const found = nodes.find(candidate => candidate.id === id);
  if (!found) throw new Error(`${file}: missing ${id}`);
  return found;
}

function rtwCore(bash: string): string {
  const beginMarker =
    '# ---- BEGIN rtw core (byte-identical across lanes; extracted by unit test) ----';
  const endMarker = '# ---- END rtw core ----';
  expect(bash.split(beginMarker)).toHaveLength(2);
  const begin = bash.indexOf(beginMarker);
  const end = bash.indexOf(endMarker, begin);
  if (begin < 0 || end < 0) throw new Error('missing rtw core marker');
  return bash.slice(begin, end + endMarker.length);
}

describe('repair-target lane wiring', () => {
  it('covers exactly all feature-development lanes', () => {
    const actual = readdirSync(LANES_DIR)
      .filter(file => /^bdc-feature-development.*\.yaml$/.test(file))
      .sort();
    expect(actual).toEqual(EXPECTED_LANES);
  });

  const canonical = rtwCore(
    node(nodesFor('bdc-feature-development-codex.yaml'), 'checkout-repair-target', 'codex').bash ??
      ''
  );

  for (const file of EXPECTED_LANES) {
    it(`${file} carries the complete repair-target contract`, () => {
      const source = readFileSync(join(LANES_DIR, file), 'utf8');
      const nodes = nodesFor(file);
      const checkout = node(nodes, 'checkout-repair-target', file);
      const review = node(nodes, 'plan-review', file);
      const decide = node(nodes, 'decide-push-target', file);
      const commit = node(nodes, 'commit-and-push', file);
      const reviewPrompt = review.loop?.prompt ?? review.prompt ?? '';

      expect(decide.prompt).toContain('$plan-review.output');
      expect(decide.prompt).toContain('Never derive it from reviewer critique outside the fence');
      expect(review.depends_on).toContain('checkout-repair-target');
      expect(reviewPrompt).toContain('$checkout-repair-target.output');
      expect(reviewPrompt.toLowerCase()).toContain('lane-verified repair-target record');
      expect(reviewPrompt).not.toContain('use WebFetch to verify that PR');
      expect(commit.bash).toContain(
        'grep -Eq "repair_target_authorized_by_spec:[[:space:]]*#${REPAIR_TARGET_PR}([^0-9]|$)" <<<"${PLAN_OUTPUT:-}"'
      );
      const core = rtwCore(checkout.bash ?? '');
      expect(core).toBe(canonical);
      expect(core).not.toContain('worktree prune');
      expect(core).not.toContain('remove --force');
      expect(source).not.toContain('git worktree prune');
    });
  }
});
