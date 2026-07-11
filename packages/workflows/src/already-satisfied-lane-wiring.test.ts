import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

const LANE_FILES = readdirSync(LANES_DIR)
  .filter(file => file.endsWith('.yaml'))
  .filter(file => readFileSync(join(LANES_DIR, file), 'utf-8').includes('gate-already-satisfied'))
  .sort();

describe('already-satisfied lane wiring', () => {
  for (const file of LANE_FILES) {
    it(`${file} wires implement to read gate-already-satisfied output`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);

      const implement = result.workflow.nodes.find(node => node.id === 'implement');
      expect(implement?.loop?.prompt).toContain('$gate-already-satisfied.output');
      expect(implement?.loop?.prompt).toContain('PRECHECK_VERDICT=already-satisfied');
      expect(implement?.loop?.prompt).toContain('Completion Criteria case 2');
    });
  }
});
