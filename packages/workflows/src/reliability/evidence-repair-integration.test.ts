import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { substituteNodeOutputRefs } from '../dag-executor';
import { fixture, body } from './evidence-repair-collector.test';
import { evidenceRepairLane, type EvidenceLaneDeps } from './evidence-repair-lane';
const head = 'a'.repeat(40);
test('unchanged evidence-only repair completes full capture/publication/new-invocation proof flow', async () => {
  const f = fixture();
  let published = false;
  let dirty = '';
  let localHead = head;
  let remoteHead = head;
  let remoteBody = body;
  const files = new Map<string, string>([
    ['implement.env', 'COMPLETE=true\nALREADY_SATISFIED=no\nEVIDENCE_ONLY_REPAIR=yes\n'],
    ['body', body],
  ]);
  const deps: EvidenceLaneDeps = {
    localHead: async () => localHead,
    git: async args =>
      args[0] === 'status' ? dirty : 'https://github.com/thinmansoftware/example.git',
    read: async name => {
      const value = files.get(name);
      if (value === undefined) throw Error('missing');
      return value;
    },
    write: async (name, value) => {
      files.set(name, value);
    },
    json: async path => {
      if (path === f.root) return { id: 1, full_name: 'thinmansoftware/example' };
      if (path.includes('/check-runs?'))
        return {
          total_count: published ? 2 : 1,
          check_runs: (published ? [30, 31] : [30]).map(id =>
            f.data.get(`${f.root}/check-runs/${id}`)
          ),
        };
      if (path.endsWith('/pulls/7'))
        return {
          ...(f.data.get(path) as object),
          head: { sha: remoteHead, repo: { id: 1 } },
          body: published ? remoteBody : 'original invalid body',
        };
      if (!f.data.has(path)) throw Error('missing');
      return f.data.get(path);
    },
    text: async path => {
      const value = f.text.get(path);
      if (value === undefined) throw Error('missing');
      return value;
    },
  };
  const snapshot = await evidenceRepairLane(
    'capture',
    `REPAIR_TARGET=#7\nREPAIR_TARGET_LEASE_SHA=${head}\n`,
    deps
  );
  expect(snapshot.state).toBe('captured');
  const input = JSON.stringify(snapshot);
  expect((await evidenceRepairLane('classify', input, deps)).state).toBe('evidence_only');
  const publication = await evidenceRepairLane('publication', input, deps, 'body');
  expect(publication.state).toBe('published');
  files.set('node-out/patch-pr-body.out', 'EVIDENCE_PUBLICATION=' + JSON.stringify(publication));
  published = true;
  const proof = await evidenceRepairLane('verify', input, deps);
  expect(proof.state).toBe('verified');
  expect((await evidenceRepairLane('terminal', input, deps, JSON.stringify(proof))).state).toBe(
    'verified'
  );
  dirty = ' M source.ts';
  expect((await evidenceRepairLane('terminal', input, deps, JSON.stringify(proof))).state).toBe(
    'unknown'
  );
  dirty = '';
  localHead = 'b'.repeat(40);
  expect((await evidenceRepairLane('terminal', input, deps, JSON.stringify(proof))).state).toBe(
    'unknown'
  );
  localHead = head;
  remoteHead = 'b'.repeat(40);
  expect((await evidenceRepairLane('terminal', input, deps, JSON.stringify(proof))).state).toBe(
    'unknown'
  );
  remoteHead = head;
  remoteBody = 'changed after receipt';
  expect((await evidenceRepairLane('terminal', input, deps, JSON.stringify(proof))).state).toBe(
    'unknown'
  );
});
const root = join(import.meta.dir, '../../../..');
const laneRoot = join(root, '.archon/workflows/defaults');
interface Node {
  id: string;
  depends_on?: string[];
  load_bearing?: boolean;
  trigger_rule?: string;
  bash?: string;
}
const lanes = readdirSync(laneRoot).filter(
  file =>
    file.endsWith('.yaml') &&
    readFileSync(join(laneRoot, file), 'utf8').includes('kind: manifest_v2') &&
    // WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01: the rebuilt lane removed the evidence repair.
    file !== 'bdc-feature-development.yaml'
);
test('bdc-feature-development.yaml (rebuilt lane) carries no evidence repair step or call', () => {
  const text = readFileSync(join(laneRoot, 'bdc-feature-development.yaml'), 'utf8');
  expect(text.includes('evidence-repair')).toBe(false);
  expect(text.includes('EVIDENCE_ONLY_REPAIR')).toBe(false);
});
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
function execute(
  node: Node,
  mode: string,
  build = 'BUILD_OUTCOME=EVIDENCE_ONLY_REPAIR',
  receipt = '{"state":"verified"}',
  evidence = 'OK'
) {
  const folder = mkdtempSync(join(tmpdir(), 'repair-lane-'));
  try {
    const bin = join(folder, 'bin');
    const out = join(folder, 'node-out');
    mkdirSync(bin);
    mkdirSync(out);
    writeFileSync(join(bin, 'bun'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$REPAIR_TEST_MODE"\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(bin, 'git'),
      '#!/usr/bin/env bash\ntouch "$ARTIFACTS_DIR/mutated"\nexit 99\n',
      { mode: 0o755 }
    );
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\ntouch \"$ARTIFACTS_DIR/mutated\"\nexit 99\n',
      { mode: 0o755 }
    );
    writeFileSync(join(out, 'evidence-repair-start.out'), '{"state":"captured"}');
    writeFileSync(join(out, 'assert-implement-produced-work.out'), build);
    writeFileSync(join(out, 'evidence-repair-verify.out'), receipt);
    const values = {
      'evidence-repair-start': '{"state":"captured"}',
      'assert-implement-produced-work': build,
      'evidence-repair-final': receipt,
      'evidence-repair-verify': receipt,
      'patch-pr-body': '',
      'block-reclassify': '{"status":"PROCEED"}',
      'manifest-evidence-check': evidence,
      'diff-review-final': 'DIFF_REVIEW_FINAL=satisfied',
      'gate-already-satisfied': '{"ALREADY_SATISFIED":false}',
      'implement-block-gate': '{"terminal":"no"}',
    };
    const outputs: Parameters<typeof substituteNodeOutputRefs>[1] = new Map(
      Object.entries(values).map(([id, output]) => [id, { state: 'completed' as const, output }])
    );
    const source = substituteNodeOutputRefs(node.bash ?? '', outputs, true);
    const result = spawnSync(bash, ['-c', source], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        ARTIFACTS_DIR: folder,
        ARCHON_NODE_OUT: out,
        REPAIR_TEST_MODE: node.id === 'blocked-terminal-gate' ? receipt : mode,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      mutated: existsSync(join(folder, 'mutated')),
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
for (const file of lanes) {
  const nodes = (parse(readFileSync(join(laneRoot, file), 'utf8')) as { nodes: Node[] }).nodes;
  const node = (id: string) => {
    const n = nodes.find(item => item.id === id);
    if (!n) throw Error(id);
    return n;
  };
  test(`${file}: classification passes through ordinary evidence gates`, () => {
    const result = execute(node('block-classify'), '');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('PROCEED');
    expect(result.stdout).not.toContain('ALREADY_SATISFIED');
  });
  test(`${file}: same PR adoption performs no commit/push/new PR`, () => {
    for (const id of ['commit-and-push', 'open-pr-if-needed']) {
      const result = execute(
        node(id),
        '{"state":"evidence_only","prUrl":"https://github.com/thinmansoftware/example/pull/7"}'
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('PR_URL=https://github.com/thinmansoftware/example/pull/7');
      expect(result.mutated).toBe(false);
    }
  });
  test(`${file}: identity failure hands off before mutation`, () => {
    for (const id of ['commit-and-push', 'open-pr-if-needed']) {
      const result = execute(node(id), '{"state":"unknown"}');
      expect(result.status).toBe(1);
      expect(result.mutated).toBe(false);
    }
  });
  test(`${file}: terminal cannot accept missing or unknown receipt`, () => {
    const terminal = node('blocked-terminal-gate');
    expect(terminal.depends_on).toContain('evidence-repair-verify');
    for (const receipt of ['', '{"state":"unknown"}', '{"state":"not_applicable"}'])
      expect(execute(terminal, '', undefined, receipt).status).toBe(1);
    expect(execute(terminal, '').status).toBe(0);
  });
  test(`${file}: original proof cannot bypass missing manifest/stops`, () => {
    const gate = node('evidence-repair-verify');
    expect(gate.load_bearing).toBe(true);
    expect(gate.depends_on).toContain('manifest-evidence-check');
    for (const evidence of ['', 'NOT_GATED:ALREADY_SATISFIED', 'NOT_GATED:BLOCKED'])
      expect(execute(gate, '{"state":"verified"}', undefined, undefined, evidence).status).toBe(1);
  });
}
