import { describe, expect, mock, test } from 'bun:test';
import {
  extractBoardSeat,
  resolveWoBoardSeatOwner,
  type OwnerResolutionOctokitLike,
} from '../owner-resolution';

function file(name: string, path: string, body: string) {
  return {
    type: 'file' as const,
    name,
    path,
    encoding: 'base64',
    content: Buffer.from(body).toString('base64'),
  };
}

function clientFor(input: {
  wo?: string;
  motionName?: string;
  motion?: string;
  failAt?: number;
}): OwnerResolutionOctokitLike {
  let call = 0;
  return {
    repos: {
      getContent: mock(async request => {
        call += 1;
        if (call === input.failAt) throw new Error('github unavailable');
        if (request.path.startsWith('docs/work-orders/')) {
          return { data: file('WO-TEST.md', request.path, input.wo ?? '') };
        }
        if (request.path === 'docs/board/motions') {
          return {
            data: input.motionName
              ? [
                  {
                    type: 'file' as const,
                    name: input.motionName,
                    path: `docs/board/motions/${input.motionName}`,
                  },
                ]
              : [],
          };
        }
        return {
          data: file(input.motionName ?? 'motion.md', request.path, input.motion ?? ''),
        };
      }),
    },
  };
}

describe('resolveWoBoardSeatOwner', () => {
  test('resolves the proposing board seat through a Parent motion reference', async () => {
    const client = clientFor({
      wo: '# WO-TEST\n\nParent motion: M-42a (CARRIED 2-0)\n',
      motionName: 'M-20260720-42a-overseer.md',
      motion: '# Motion\n\n**Proposed by:** GPT/Sol\n',
    });
    expect(await resolveWoBoardSeatOwner('WO-TEST', client)).toBe('Codex');
  });

  test.each(['GPT', 'Codex', 'Sol'])('returns the Codex seat for %s proposer text', proposer => {
    expect(extractBoardSeat(`**Proposed by:** ${proposer}\n`)).toBe('Codex');
  });

  test('returns null when the WO has no Parent motion reference', async () => {
    expect(
      await resolveWoBoardSeatOwner('WO-TEST', clientFor({ wo: '# WO-TEST\nBuilder: Codex\n' }))
    ).toBeNull();
  });

  test('maps a motion moved through the acting XO to the Claude seat', () => {
    expect(extractBoardSeat('**Mover:** John Ranson, through the acting XO\n')).toBe('Claude');
  });

  test('returns null when the referenced motion cannot be found', async () => {
    expect(
      await resolveWoBoardSeatOwner(
        'WO-TEST',
        clientFor({ wo: 'Parent motion: M-99\n', motionName: undefined })
      )
    ).toBeNull();
  });

  test('returns null for an ambiguous or unparseable motion', async () => {
    const ambiguous =
      '# Motion\n\n**Proposed by:** Board\n\n### Claude -- APPROVE\n### GPT -- APPROVE\n';
    expect(extractBoardSeat(ambiguous)).toBeNull();
    expect(
      await resolveWoBoardSeatOwner(
        'WO-TEST',
        clientFor({
          wo: 'Parent motion: M-42\n',
          motionName: 'M-20260720-42-test.md',
          motion: ambiguous,
        })
      )
    ).toBeNull();
  });

  test('returns null without throwing when GitHub fails at any lookup step', async () => {
    for (const failAt of [1, 2, 3]) {
      const result = await resolveWoBoardSeatOwner(
        'WO-TEST',
        clientFor({
          wo: 'Parent motion: M-42\n',
          motionName: 'M-20260720-42-test.md',
          motion: '**Proposed by:** Grok\n',
          failAt,
        })
      );
      expect(result).toBeNull();
    }
  });
});
