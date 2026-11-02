import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

import {
  decide,
  main,
  verifyComposeYaml,
  verifyDelta,
  verifyDoc,
} from './verify-seccomp-userns.mjs';

const SIGCHLD = 17;
const CLONE_NEWNS = 0x20000;
const CLONE_NEWCGROUP = 0x2000000;
const CLONE_NEWUTS = 0x4000000;
const CLONE_NEWIPC = 0x8000000;
const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWPID = 0x20000000;
const CLONE_NEWNET = 0x40000000;
const COMBINED = 0x78020000;

const SECCOMP_OPT = 'seccomp=./docker/seccomp-archon.json';
const SECURITY_BLOCK = `    security_opt:\n      - ${SECCOMP_OPT}\n`;
const UPSTREAM_SHA256 = '01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28';
const HASHED_FILES = [
  'docker-compose.yml',
  'docker/seccomp-upstream-29.3.0.json',
  'docker/seccomp-archon.json',
  'docker/seccomp-archon.md',
];

function repoUrl(relativePath) {
  return new URL(`../${relativePath}`, import.meta.url);
}

function repoBytes(relativePath) {
  return readFileSync(repoUrl(relativePath));
}

function repoText(relativePath) {
  return repoBytes(relativePath).toString('utf8');
}

function loadProfiles() {
  return {
    upstream: JSON.parse(repoText('docker/seccomp-upstream-29.3.0.json')),
    archon: JSON.parse(repoText('docker/seccomp-archon.json')),
  };
}

function clonePair() {
  const profiles = loadProfiles();
  return { upstream: profiles.upstream, archon: structuredClone(profiles.archon) };
}

function suffixOf(pair) {
  return pair.archon.syscalls.slice(pair.upstream.syscalls.length);
}

function assertRejected(mutate) {
  const pair = clonePair();
  mutate(pair);
  assert.throws(() => verifyDelta(pair.upstream, pair.archon));
}

function cloneScenario(arch, flags, other = 0) {
  const args = arch === 's390x' ? [other, flags] : [flags, other];
  return { syscall: 'clone', arch, caps: [], args };
}

test('pinned baseline keeps the upstream prefix, five-rule suffix, and clone3 errno 38', () => {
  const upstreamBytes = repoBytes('docker/seccomp-upstream-29.3.0.json');
  assert.equal(createHash('sha256').update(upstreamBytes).digest('hex'), UPSTREAM_SHA256);
  const { upstream, archon } = loadProfiles();
  verifyDelta(upstream, archon);
  assert.deepEqual(archon.syscalls.slice(0, upstream.syscalls.length), upstream.syscalls);
  assert.equal(archon.syscalls.length, upstream.syscalls.length + 5);
  const clone3 = upstream.syscalls.find(
    rule => rule.names?.includes('clone3') && rule.action === 'SCMP_ACT_ERRNO'
  );
  assert.ok(clone3);
  assert.equal(clone3.errnoRet, 38);
  assert.ok(clone3.excludes.caps.includes('CAP_SYS_ADMIN'));
  const valueTwos = suffixOf({ upstream, archon })
    .flatMap(rule => (rule.args ?? []).map(arg => arg.valueTwo))
    .filter(value => value !== undefined)
    .sort((left, right) => left - right);
  assert.deepEqual(valueTwos, [268435456, 268435456, 2013396992, 2013396992]);
});

test('compose wires the profile only on the app service', () => {
  const text = repoText('docker-compose.yml');
  assert.equal(text.split(SECCOMP_OPT).length - 1, 1);
  verifyComposeYaml(text);
  const doc = parseYaml(text);
  assert.deepEqual(doc.services.app.security_opt, [SECCOMP_OPT]);
  assert.equal(doc.services.app.privileged, undefined);
  assert.equal(doc.services.app.cap_add, undefined);
  for (const option of doc.services.app.security_opt) {
    assert.equal(String(option).toLowerCase().includes('unconfined'), false);
    assert.equal(String(option).toLowerCase().includes('apparmor'), false);
  }
  for (const [name, service] of Object.entries(doc.services)) {
    if (name === 'app') continue;
    assert.equal(JSON.stringify(service).includes(SECCOMP_OPT), false);
  }
});

test('explicit false privileged and empty cap_add stay allowed', () => {
  const text = repoText('docker-compose.yml').replace(
    SECURITY_BLOCK,
    `    privileged: false\n    cap_add: []\n${SECURITY_BLOCK}`
  );
  verifyComposeYaml(text);
});

test('effective amd64 and s390x clone decisions', () => {
  assert.equal(COMBINED, CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET);
  const { archon } = loadProfiles();
  const allowed = [SIGCHLD, CLONE_NEWUSER | SIGCHLD, COMBINED | SIGCHLD];
  const denied = [
    CLONE_NEWNS,
    CLONE_NEWNET,
    CLONE_NEWUSER | CLONE_NEWUTS,
    CLONE_NEWUSER | CLONE_NEWCGROUP,
    0xffffffff,
  ];
  for (const arch of ['amd64', 's390x']) {
    for (const flags of allowed) {
      assert.deepEqual(decide(archon, cloneScenario(arch, flags)), { action: 'ALLOW' });
    }
    for (const flags of denied) {
      assert.deepEqual(decide(archon, cloneScenario(arch, flags)), { action: 'DEFAULT', errno: 1 });
    }
  }
});

test('s390 uses argument index 1 and amd64 uses argument index 0', () => {
  const { archon } = loadProfiles();
  assert.deepEqual(
    decide(archon, {
      syscall: 'clone',
      arch: 's390x',
      caps: [],
      args: [CLONE_NEWUSER | SIGCHLD, CLONE_NEWNS],
    }),
    { action: 'DEFAULT', errno: 1 }
  );
  assert.deepEqual(
    decide(archon, {
      syscall: 'clone',
      arch: 's390x',
      caps: [],
      args: [0, CLONE_NEWUSER | SIGCHLD],
    }),
    { action: 'ALLOW' }
  );
  assert.deepEqual(
    decide(archon, {
      syscall: 'clone',
      arch: 's390x',
      caps: [],
      args: [CLONE_NEWNS, COMBINED | SIGCHLD],
    }),
    { action: 'ALLOW' }
  );
  assert.deepEqual(
    decide(archon, {
      syscall: 'clone',
      arch: 'amd64',
      caps: [],
      args: [CLONE_NEWUSER | SIGCHLD, CLONE_NEWNS],
    }),
    { action: 'ALLOW' }
  );
  assert.deepEqual(
    decide(archon, {
      syscall: 'clone',
      arch: 'amd64',
      caps: [],
      args: [CLONE_NEWNS, CLONE_NEWUSER | SIGCHLD],
    }),
    { action: 'DEFAULT', errno: 1 }
  );
});

test('clone3, unshare, mount, umount2, and setns keep their bounded results', () => {
  const { archon } = loadProfiles();
  for (const arch of ['amd64', 's390x']) {
    assert.deepEqual(decide(archon, { syscall: 'clone3', arch, caps: [], args: [] }), {
      action: 'ERRNO',
      errno: 38,
    });
    assert.deepEqual(decide(archon, { syscall: 'unshare', arch, caps: [], args: [] }), {
      action: 'ALLOW',
    });
    for (const syscall of ['mount', 'umount2', 'setns']) {
      assert.deepEqual(decide(archon, { syscall, arch, caps: [], args: [] }), {
        action: 'DEFAULT',
        errno: 1,
      });
    }
  }
  assert.deepEqual(
    decide(archon, { syscall: 'clone3', arch: 'amd64', caps: ['CAP_SYS_ADMIN'], args: [] }),
    { action: 'ALLOW' }
  );
  assert.deepEqual(
    decide(archon, { syscall: 'mount', arch: 'amd64', caps: ['CAP_SYS_ADMIN'], args: [] }),
    { action: 'ALLOW' }
  );
});

test('changed clone mask is rejected', () => {
  assertRejected(pair => {
    suffixOf(pair)[0].args[0].value = 1;
  });
});

test('changed valueTwo is rejected', () => {
  assertRejected(pair => {
    suffixOf(pair)[0].args[0].valueTwo = 1;
  });
});

test('explicit zero valueTwo is not the omitted upstream valueTwo', () => {
  assertRejected(pair => {
    const rule = pair.archon.syscalls.find(
      item =>
        item.names?.length === 1 &&
        item.names[0] === 'clone' &&
        item.args?.[0]?.index === 0 &&
        !Object.prototype.hasOwnProperty.call(item.args[0], 'valueTwo')
    );
    assert.ok(rule);
    rule.args[0].valueTwo = 0;
  });
});

test('s390 clone rule moved to argument index 0 is rejected', () => {
  assertRejected(pair => {
    const rule = suffixOf(pair).find(item => item.args?.[0]?.index === 1);
    assert.ok(rule);
    rule.args[0].index = 0;
  });
});

test('missing architecture conditions are rejected', () => {
  assertRejected(pair => {
    for (const rule of suffixOf(pair)) {
      if (rule.includes) delete rule.includes.arches;
      if (rule.excludes?.arches) delete rule.excludes.arches;
    }
  });
});

test('missing CAP_SYS_ADMIN exclusion is rejected', () => {
  assertRejected(pair => {
    const rule = suffixOf(pair).find(item => item.names?.[0] === 'clone');
    assert.ok(rule);
    delete rule.excludes.caps;
  });
});

test('unrestricted clone is rejected', () => {
  assertRejected(pair => {
    pair.archon.syscalls.push({ names: ['clone'], action: 'SCMP_ACT_ALLOW' });
  });
});

test('clone3 allow is rejected', () => {
  assertRejected(pair => {
    const rule = pair.archon.syscalls.find(
      item => item.names?.includes('clone3') && item.action === 'SCMP_ACT_ERRNO'
    );
    assert.ok(rule);
    rule.action = 'SCMP_ACT_ALLOW';
    delete rule.errnoRet;
  });
});

test('changed clone3 errno is rejected', () => {
  assertRejected(pair => {
    const rule = pair.archon.syscalls.find(
      item => item.names?.includes('clone3') && item.action === 'SCMP_ACT_ERRNO'
    );
    assert.ok(rule);
    rule.errnoRet = 1;
  });
});

test('added mount rule is rejected', () => {
  assertRejected(pair => {
    pair.archon.syscalls.push({ names: ['mount'], action: 'SCMP_ACT_ALLOW' });
  });
});

test('added umount2 rule is rejected', () => {
  assertRejected(pair => {
    pair.archon.syscalls.push({ names: ['umount2'], action: 'SCMP_ACT_ALLOW' });
  });
});

test('added setns rule is rejected', () => {
  assertRejected(pair => {
    pair.archon.syscalls.push({ names: ['setns'], action: 'SCMP_ACT_ALLOW' });
  });
});

test('malformed JSON is rejected', () => {
  assert.throws(() => verifyDelta('{', '{'));
  assert.throws(() => verifyDelta('{}', '{}'));
});

test('missing app seccomp reference is rejected', () => {
  const text = repoText('docker-compose.yml').replace(SECURITY_BLOCK, '');
  assert.throws(() => verifyComposeYaml(text));
});

test('duplicated seccomp reference is rejected', () => {
  const text = repoText('docker-compose.yml').replace(
    SECURITY_BLOCK,
    SECURITY_BLOCK + SECURITY_BLOCK
  );
  assert.throws(() => verifyComposeYaml(text));
});

test('seccomp reference on another service is rejected', () => {
  const text = repoText('docker-compose.yml')
    .replace(SECURITY_BLOCK, '')
    .replace('  postgres:\n', `  postgres:\n${SECURITY_BLOCK}`);
  assert.throws(() => verifyComposeYaml(text));
});

test('privileged app is rejected', () => {
  const text = repoText('docker-compose.yml').replace(
    SECURITY_BLOCK,
    `    privileged: true\n${SECURITY_BLOCK}`
  );
  assert.throws(() => verifyComposeYaml(text));
});

test('cap_add on the app is rejected', () => {
  const text = repoText('docker-compose.yml').replace(
    SECURITY_BLOCK,
    `    cap_add:\n      - SYS_ADMIN\n${SECURITY_BLOCK}`
  );
  assert.throws(() => verifyComposeYaml(text));
});

test('apparmor unconfined is rejected', () => {
  const text = repoText('docker-compose.yml').replace(
    SECURITY_BLOCK,
    `    security_opt:\n      - ${SECCOMP_OPT}\n      - apparmor=unconfined\n`
  );
  assert.throws(() => verifyComposeYaml(text));
});

test('seccomp unconfined is rejected', () => {
  const text = repoText('docker-compose.yml').replace(SECCOMP_OPT, 'seccomp=unconfined');
  assert.throws(() => verifyComposeYaml(text));
});

test('repeated verification leaves repository fixtures unchanged', () => {
  const hashFiles = () =>
    HASHED_FILES.map(relativePath =>
      createHash('sha256').update(repoBytes(relativePath)).digest('hex')
    ).join('\n');
  const before = hashFiles();
  main();
  assert.equal(hashFiles(), before);
  main();
  assert.equal(hashFiles(), before);
});

test('documentation records provenance and the blocked sandbox boundary', () => {
  verifyDoc(repoText('docker/seccomp-archon.md'));
});

test('documentation rejects a native sandbox acceptance PASS claim', () => {
  const text = `${repoText('docker/seccomp-archon.md')}\nnative sandbox acceptance is PASS\n`;
  assert.throws(() => verifyDoc(text));
});

test('documentation rejects a dropped mount-failure sentence', () => {
  const text = repoText('docker/seccomp-archon.md').replace(
    'bwrap: Failed to make / slave: Operation not permitted',
    'mount setup finished'
  );
  assert.throws(() => verifyDoc(text));
});

test('documentation rejects closing parent issues or a production PASS claim', () => {
  const original = repoText('docker/seccomp-archon.md');
  assert.throws(() => verifyDoc(`${original}\ncloses #3654\n`));
  assert.throws(() => verifyDoc(`${original}\ncloses #3258\n`));
  assert.throws(() => verifyDoc(`${original}\nproduction activation is PASS\n`));
  assert.throws(() => verifyDoc(`${original}\nfull sandbox acceptance is PASS\n`));
});
