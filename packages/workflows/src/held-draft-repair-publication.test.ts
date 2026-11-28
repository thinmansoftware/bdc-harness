import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lanesDir = join(import.meta.dir, '../../../.archon/workflows/defaults');
const lanes = readdirSync(lanesDir).filter(
  name =>
    name.endsWith('.yaml') &&
    readFileSync(join(lanesDir, name), 'utf8').includes('REPAIR_TARGET_LEASE_SHA=')
);

function publication(file: string, context: string | null, lease = '', removeGuard = false) {
  const yaml = readFileSync(join(lanesDir, file), 'utf8').replaceAll('\r', '');
  const create = /^ +CREATE_OUT=\$\(gh pr create\b[^\n]*$/m.exec(yaml);
  if (!create) throw new Error(`${file}: PR create command not found`);
  const marker = yaml.lastIndexOf('# held-draft-repair-no-create: begin', create.index);
  expect(marker, file).toBeGreaterThan(0);
  if (file === 'bdc-feature-development.yaml') expect(create[0]).toContain(' --draft ');
  const fragment = yaml
    .slice(removeGuard ? create.index : marker, create.index + create[0].length)
    .replace(/^      /gm, '');
  const root = mkdtempSync(join(tmpdir(), 'held-repair-publish-'));
  try {
    const out = join(root, 'node-out');
    mkdirSync(out);
    if (context !== null) writeFileSync(join(out, 'checkout-repair-target.out'), context);
    const log = join(root, 'gh-writes');
    const script = join(root, 'publish.sh');
    writeFileSync(
      script,
      `set -euo pipefail
gh() { printf 'CREATE\\n' >> "$WRITE_LOG"; printf 'https://github.com/example/repo/pull/1\\n'; }
git() { exit 97; }
ssh() { exit 97; }
curl() { exit 97; }
declare -F gh >/dev/null || exit 98
REPO=example/repo TITLE=fixture BODY_FILE=fixture UNIQUE_BRANCH=fixture BASE_BRANCH=dev CREATE_RC=0
${fragment}
`
    );
    const env = {
      ...process.env,
      ARCHON_NODE_OUT: out.replaceAll('\\', '/'),
      WRITE_LOG: log.replaceAll('\\', '/'),
      REPAIR_TARGET_LEASE_SHA: lease,
    };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const result = Bun.spawnSync(['bash', script.replaceAll('\\', '/')], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: result.exitCode,
      error: result.stderr.toString(),
      writes: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('all thirteen repair-capable lanes refuse sibling PR creation for repair or unknown context', () => {
  expect(lanes).toHaveLength(13);
  for (const file of lanes) {
    for (const context of [
      null,
      '',
      'REPAIR_TARGET=#117\n',
      'REPAIR_TARGET=none\nREPAIR_TARGET=#117\n',
    ]) {
      const result = publication(file, context);
      expect(result.code, `${file}: ${result.error}`).not.toBe(0);
      expect(result.writes, file).toBe(0);
    }
    const leased = publication(file, 'REPAIR_TARGET=none\n', 'a'.repeat(40));
    expect(leased.code, file).not.toBe(0);
    expect(leased.writes, file).toBe(0);
  }
});

test('proven ordinary publication remains reachable and the negative control detects a removed guard', () => {
  for (const file of lanes) {
    const normal = publication(file, 'REPAIR_TARGET=none\n');
    expect(normal.code, `${file}: ${normal.error}`).toBe(0);
    expect(normal.writes, file).toBe(1);
    const mutant = publication(file, 'REPAIR_TARGET=#117\n', '', true);
    expect(mutant.code, `${file}: ${mutant.error}`).toBe(0);
    expect(mutant.writes, file).toBe(1);
  }
});
