import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = new URL('..', import.meta.url);
const UPSTREAM_SHA256 = '01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28';
const CLONE_MASK = 2114060288;
const USER_NAMESPACE = 268435456;
const COMBINED_NAMESPACES = 2013396992;
const SECCOMP_OPT = 'seccomp=./docker/seccomp-archon.json';
const UINT32_MASK = 0xffffffffn;

const REQUIRED_DOC_TEXT = [
  '83bca512aa7ffc1bb4f37ce1107e0d3e3489ad43',
  '01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28',
  '268435456',
  '2013396992',
  '2114060288',
  'errnoRet 38',
  'bwrap: Failed to make / slave: Operation not permitted',
  'CODEX_SANDBOX_OK was NOT printed',
  'BLOCKED',
  'UNVERIFIED',
  'no deployment authority',
  'docker-default',
];

const PASS_CLAIM =
  /(native sandbox acceptance|full sandbox acceptance|full native sandbox acceptance|production activation)[^\n]{0,80}\bPASS\b/;

function repoUrl(relativePath) {
  return new URL(relativePath, ROOT);
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !deepEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function coerceProfile(value, label) {
  let profile = value;
  if (typeof value === 'string') {
    try {
      profile = JSON.parse(value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${label} profile is malformed JSON: ${message}`);
    }
  }
  if (
    !profile ||
    typeof profile !== 'object' ||
    Array.isArray(profile) ||
    !Array.isArray(profile.syscalls)
  ) {
    throw new Error(`${label} profile is malformed JSON`);
  }
  return profile;
}

function sameKeySet(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function isUnprivilegedClone(rule, index) {
  if (!rule || typeof rule !== 'object') return false;
  if (!Array.isArray(rule.names) || rule.names.length !== 1 || rule.names[0] !== 'clone') {
    return false;
  }
  if (rule.action !== 'SCMP_ACT_ALLOW' || !Array.isArray(rule.args) || rule.args.length !== 1) {
    return false;
  }
  const arg = rule.args[0];
  if (!arg || arg.index !== index || arg.value !== CLONE_MASK || arg.op !== 'SCMP_CMP_MASKED_EQ') {
    return false;
  }
  // Missing valueTwo is the upstream no-namespace rule. Explicit 0 is a different rule.
  if (Object.prototype.hasOwnProperty.call(arg, 'valueTwo')) return false;
  const excludedCaps = Array.isArray(rule.excludes?.caps) ? rule.excludes.caps : [];
  if (!excludedCaps.includes('CAP_SYS_ADMIN')) return false;
  if (index === 0) {
    const excludedArches = Array.isArray(rule.excludes?.arches) ? rule.excludes.arches : [];
    return excludedArches.includes('s390') && excludedArches.includes('s390x');
  }
  const includedArches = Array.isArray(rule.includes?.arches) ? rule.includes.arches : [];
  return includedArches.includes('s390') && includedArches.includes('s390x');
}

function findUnprivilegedClone(syscalls, index) {
  const matches = syscalls.filter(rule => isUnprivilegedClone(rule, index));
  if (matches.length !== 1) {
    throw new Error(
      `expected one unprivileged clone rule at argument index ${index}, found ${matches.length}`
    );
  }
  return matches[0];
}

function withValueTwo(rule, valueTwo) {
  const copy = structuredClone(rule);
  if (!Array.isArray(copy.args) || copy.args.length !== 1) {
    throw new Error('unprivileged clone rule is missing its argument filter');
  }
  if (Object.prototype.hasOwnProperty.call(copy.args[0], 'valueTwo')) {
    throw new Error('upstream clone rule already sets valueTwo');
  }
  copy.args[0].valueTwo = valueTwo;
  return copy;
}

function countNaming(profile, name) {
  return profile.syscalls.filter(rule => Array.isArray(rule?.names) && rule.names.includes(name))
    .length;
}

function assertClone3Errno(prefix) {
  const errnoRules = prefix.filter(
    rule =>
      Array.isArray(rule?.names) &&
      rule.names.includes('clone3') &&
      rule.action === 'SCMP_ACT_ERRNO'
  );
  if (errnoRules.length !== 1) {
    throw new Error('upstream prefix must contain exactly one clone3 errno rule');
  }
  const rule = errnoRules[0];
  if (rule.errnoRet !== 38) {
    throw new Error(`clone3 errnoRet must stay 38, found ${String(rule.errnoRet)}`);
  }
  const excludedCaps = Array.isArray(rule.excludes?.caps) ? rule.excludes.caps : [];
  if (!excludedCaps.includes('CAP_SYS_ADMIN')) {
    throw new Error('clone3 errno rule must keep the CAP_SYS_ADMIN exclusion');
  }
}

export function verifyDelta(upstreamValue, archonValue) {
  const upstream = coerceProfile(upstreamValue, 'upstream');
  const archon = coerceProfile(archonValue, 'candidate');
  if (!sameKeySet(upstream, archon)) {
    throw new Error('top-level seccomp key set changed');
  }
  if (upstream.defaultAction !== archon.defaultAction) {
    throw new Error('defaultAction changed');
  }
  if (upstream.defaultErrnoRet !== archon.defaultErrnoRet) {
    throw new Error('defaultErrnoRet changed');
  }
  if (!deepEqual(upstream.archMap, archon.archMap)) {
    throw new Error('archMap changed');
  }
  if (archon.syscalls.length !== upstream.syscalls.length + 5) {
    throw new Error(
      `candidate must append exactly five rules, found ${archon.syscalls.length - upstream.syscalls.length}`
    );
  }
  const prefix = archon.syscalls.slice(0, upstream.syscalls.length);
  assertClone3Errno(prefix);
  if (!deepEqual(prefix, upstream.syscalls)) {
    throw new Error('candidate syscall prefix does not match the pinned upstream profile');
  }
  for (const name of ['mount', 'umount2', 'setns', 'clone3']) {
    const before = countNaming(upstream, name);
    const after = countNaming(archon, name);
    if (before !== after) {
      throw new Error(`${name} rule count changed from ${before} to ${after}`);
    }
  }

  const normal = findUnprivilegedClone(upstream.syscalls, 0);
  const s390 = findUnprivilegedClone(upstream.syscalls, 1);
  const expected = [
    withValueTwo(normal, USER_NAMESPACE),
    withValueTwo(s390, USER_NAMESPACE),
    withValueTwo(normal, COMBINED_NAMESPACES),
    withValueTwo(s390, COMBINED_NAMESPACES),
    { names: ['unshare'], action: 'SCMP_ACT_ALLOW' },
  ];
  const actual = archon.syscalls.slice(upstream.syscalls.length);
  const actualKeys = actual.map(rule => canonical(rule)).sort();
  const expectedKeys = expected.map(rule => canonical(rule)).sort();
  if (!deepEqual(actualKeys, expectedKeys)) {
    throw new Error('appended seccomp rules are not the five-rule user-namespace delta');
  }
}

function toUint32(value) {
  return BigInt(value) & UINT32_MASK;
}

function constraintsMatch(rule, scenario) {
  const caps = Array.isArray(scenario.caps) ? scenario.caps : [];
  if (rule.includes) {
    if (Array.isArray(rule.includes.arches) && rule.includes.arches.length > 0) {
      if (!rule.includes.arches.includes(scenario.arch)) return false;
    }
    if (Array.isArray(rule.includes.caps) && rule.includes.caps.length > 0) {
      if (!rule.includes.caps.every(cap => caps.includes(cap))) return false;
    }
    // includes.minKernel is applicable: it does not reject the rule.
  }
  if (rule.excludes) {
    if (Array.isArray(rule.excludes.arches) && rule.excludes.arches.length > 0) {
      if (rule.excludes.arches.includes(scenario.arch)) return false;
    }
    if (Array.isArray(rule.excludes.caps) && rule.excludes.caps.length > 0) {
      if (rule.excludes.caps.every(cap => caps.includes(cap))) return false;
    }
  }
  return true;
}

function argumentMatches(condition, args) {
  if (!condition || typeof condition.index !== 'number') return false;
  if (!Array.isArray(args) || condition.index < 0 || condition.index >= args.length) return false;
  let flags;
  let value;
  try {
    flags = toUint32(args[condition.index]);
    value = toUint32(condition.value);
  } catch {
    return false;
  }
  if (condition.op === 'SCMP_CMP_MASKED_EQ') {
    let valueTwo;
    try {
      valueTwo = toUint32(condition.valueTwo ?? 0);
    } catch {
      return false;
    }
    return (flags & value) === valueTwo;
  }
  if (condition.op === 'SCMP_CMP_EQ') return flags === value;
  if (condition.op === 'SCMP_CMP_NE') return flags !== value;
  return false;
}

function actionResult(rule, profile) {
  if (rule.action === 'SCMP_ACT_ALLOW') return { action: 'ALLOW' };
  if (rule.action === 'SCMP_ACT_ERRNO') {
    return { action: 'ERRNO', errno: rule.errnoRet ?? profile.defaultErrnoRet };
  }
  return { action: rule.action };
}

export function decide(profile, scenario) {
  const args = scenario.args ?? [];
  for (const rule of profile.syscalls) {
    if (!rule || typeof rule !== 'object' || !Array.isArray(rule.names)) continue;
    if (!rule.names.includes(scenario.syscall)) continue;
    if (!constraintsMatch(rule, scenario)) continue;
    if (Array.isArray(rule.args) && rule.args.length > 0) {
      if (!rule.args.every(condition => argumentMatches(condition, args))) continue;
    }
    return actionResult(rule, profile);
  }
  return { action: 'DEFAULT', errno: profile.defaultErrnoRet };
}

export function verifyComposeYaml(text) {
  if (typeof text !== 'string') throw new Error('compose text must be a string');
  const occurrences = text.split(SECCOMP_OPT).length - 1;
  if (occurrences !== 1) {
    throw new Error(`compose must reference ${SECCOMP_OPT} exactly once, found ${occurrences}`);
  }
  let doc;
  try {
    doc = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`compose YAML is malformed: ${message}`);
  }
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
    throw new Error('compose is missing services');
  }
  const app = doc.services.app;
  if (!app || typeof app !== 'object') throw new Error('compose is missing services.app');
  const options = app.security_opt;
  if (!Array.isArray(options) || options.length !== 1 || options[0] !== SECCOMP_OPT) {
    throw new Error('services.app.security_opt must be exactly the archon seccomp profile');
  }
  for (const option of options) {
    const lower = String(option).toLowerCase();
    if (lower.includes('unconfined') || lower.includes('apparmor')) {
      throw new Error('services.app.security_opt must not set unconfined or apparmor');
    }
  }
  if (app.privileged !== undefined && app.privileged !== false) {
    throw new Error('services.app.privileged must stay absent or false');
  }
  if (app.cap_add !== undefined && !(Array.isArray(app.cap_add) && app.cap_add.length === 0)) {
    throw new Error('services.app.cap_add must stay absent or empty');
  }
  for (const [name, service] of Object.entries(doc.services)) {
    if (name === 'app' || !service || typeof service !== 'object') continue;
    if (JSON.stringify(service).includes(SECCOMP_OPT)) {
      throw new Error(`service ${name} must not reference the archon seccomp profile`);
    }
  }
}

export function verifyDoc(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('seccomp documentation is missing');
  }
  for (const literal of REQUIRED_DOC_TEXT) {
    if (!text.includes(literal)) {
      throw new Error(`seccomp documentation is missing required text: ${literal}`);
    }
  }
  if (/closes\s*:?\s*#3654/i.test(text) || /closes\s*:?\s*#3258/i.test(text)) {
    throw new Error('seccomp documentation must not claim this change closes #3654 or #3258');
  }
  if (PASS_CLAIM.test(text)) {
    throw new Error('seccomp documentation must not claim sandbox or production acceptance PASS');
  }
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryPath = decodeURIComponent(pathToFileURL(realpathSync(entry)).pathname);
    const modulePath = decodeURIComponent(new URL(import.meta.url).pathname);
    return entryPath === modulePath;
  } catch {
    return false;
  }
}

export function main() {
  try {
    const upstreamBytes = readFileSync(repoUrl('docker/seccomp-upstream-29.3.0.json'));
    const actual = createHash('sha256').update(upstreamBytes).digest('hex');
    if (actual !== UPSTREAM_SHA256) {
      throw new Error(`upstream fixture sha256 mismatch: ${actual}`);
    }
    let upstream;
    let archon;
    try {
      upstream = JSON.parse(upstreamBytes.toString('utf8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`upstream fixture is malformed JSON: ${message}`);
    }
    try {
      archon = JSON.parse(readFileSync(repoUrl('docker/seccomp-archon.json')).toString('utf8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`archon profile is malformed JSON: ${message}`);
    }
    verifyDelta(upstream, archon);
    verifyComposeYaml(readFileSync(repoUrl('docker-compose.yml')).toString('utf8'));
    verifyDoc(readFileSync(repoUrl('docker/seccomp-archon.md')).toString('utf8'));
  } catch (err) {
    if (isDirectInvocation()) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exit(1);
    }
    throw err;
  }
}

if (isDirectInvocation()) {
  main();
  console.log('seccomp userns verification passed');
}
