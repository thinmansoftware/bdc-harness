import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { isBoardAliasMessage, renderBoardMotionPrompt } from './board-motion';

describe('dispatch worker board motion helpers', () => {
  test('renders board motion prompt from validated pointer fields only', () => {
    const prompt = renderBoardMotionPrompt(
      JSON.stringify({
        motion_id: 'M-27',
        title: 'Board Motion Dispatch',
        file_path: 'docs/board/motions/M-27.md',
      })
    );

    expect(prompt).toContain('M-27');
    expect(prompt).toContain('Board Motion Dispatch');
    expect(prompt).toContain('docs/board/motions/M-27.md');
    expect(prompt).not.toContain('APPROVE');
  });

  test('identifies board alias rows without requiring a board agent', () => {
    expect(isBoardAliasMessage({ recipient: 'board' })).toBe(true);
    expect(isBoardAliasMessage({ recipient: 'claude', recipient_alias: 'board' })).toBe(true);
    expect(isBoardAliasMessage({ recipient: 'claude' })).toBe(false);
  });

  test('worker source remains delivery-only', () => {
    const root = join(import.meta.dir);
    const source = [
      readFileSync(join(root, 'index.ts'), 'utf8'),
      readFileSync(join(root, 'board-motion.ts'), 'utf8'),
    ].join('\n');

    expect(source).toContain('delivery_principal');
    expect(source).not.toContain("config.agents['board']");
    expect(source).not.toContain('execution_claim');
    expect(source).not.toContain('board_execution_claim');
    expect(source).not.toContain(['xo', 'holder'].join('_'));
    expect(source).not.toContain(['X-XO', 'Holder'].join('-'));
  });
});
