// Unit test for the Test Suite workflow's Windows-on-push condition.
// (WO-HARNESS-CI-WINDOWS-ON-MERGE-ONLY-01)
//
// Parses .github/workflows/test.yml. No live GitHub Actions run.
//
// Run standalone (NOT picked up by `bun run test`, which is workspace-scoped
// to packages/*):
//   bun test scripts/ci/test-workflow.test.ts

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

interface WorkflowJob {
  name?: string;
  'runs-on'?: string;
  if?: string;
}

interface WorkflowOn {
  push?: { branches?: string[] };
  pull_request?: { branches?: string[] };
}

interface WorkflowFile {
  on?: WorkflowOn;
  jobs?: Record<string, WorkflowJob>;
}

const workflowPath = join(import.meta.dir, '../../.github/workflows/test.yml');
const workflow = parse(readFileSync(workflowPath, 'utf8')) as WorkflowFile;

function eventConditionHolds(expression: string, eventName: string): boolean {
  const match = /github\.event_name\s*==\s*'([^']+)'/.exec(expression);
  if (match === null || match[1] === undefined) {
    throw new Error(`unexpected Windows job condition: ${expression}`);
  }
  return eventName === match[1];
}

test('both OS runners are still declared on the split jobs', () => {
  const jobs = workflow.jobs ?? {};
  const runsOn = Object.values(jobs).map(job => job['runs-on']);
  expect(runsOn).toContain('ubuntu-latest');
  expect(runsOn).toContain('windows-latest');
  expect(jobs['test-ubuntu']?.['runs-on']).toBe('ubuntu-latest');
  expect(jobs['test-windows']?.['runs-on']).toBe('windows-latest');
  expect(jobs['test-ubuntu']?.name).toBe('test (ubuntu-latest)');
  expect(jobs['test-windows']?.name).toBe('test (windows-latest)');
});

test('Windows condition is false for pull_request and true for push', () => {
  const condition = workflow.jobs?.['test-windows']?.if;
  expect(condition).toBeDefined();
  if (condition === undefined) {
    return;
  }
  expect(eventConditionHolds(condition, 'pull_request')).toBe(false);
  expect(eventConditionHolds(condition, 'push')).toBe(true);
});

test('ubuntu, postgres, and docker-build jobs have no event condition', () => {
  expect(workflow.jobs?.['test-ubuntu']?.if).toBeUndefined();
  expect(workflow.jobs?.['dispatch-phase15-postgres']?.if).toBeUndefined();
  expect(workflow.jobs?.['docker-build']?.if).toBeUndefined();
});

test('push and pull_request triggers still target main and dev', () => {
  const on = workflow.on;
  expect(on?.push?.branches).toEqual(['main', 'dev']);
  expect(on?.pull_request?.branches).toEqual(['main', 'dev']);
});
