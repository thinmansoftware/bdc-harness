import { describe, expect, it } from 'bun:test';
import { ghPrListForBranchDefault } from './poll';

describe('Test 4: Smart Cauldron gh child auth', () => {
  it('passes the resolved service token in the child environment', async () => {
    let childToken = '';
    await ghPrListForBranchDefault(
      'branch',
      'owner/repo',
      async (_command, _args, options) => {
        childToken = options?.env?.GH_TOKEN ?? '';
        return { stdout: '', stderr: '' };
      },
      async () => ({ env: { GH_TOKEN: 'marker-token' }, poolId: 'app-1-2' })
    );
    expect(childToken).toBe('marker-token');
  });

  it('preserves the resolved legacy PAT', async () => {
    let childToken = '';
    await ghPrListForBranchDefault(
      'branch',
      'owner/repo',
      async (_command, _args, options) => {
        childToken = options?.env?.GH_TOKEN ?? '';
        return { stdout: '', stderr: '' };
      },
      async () => ({ env: { GH_TOKEN: 'legacy-marker' }, poolId: 'user-pat' })
    );
    expect(childToken).toBe('legacy-marker');
  });
});
