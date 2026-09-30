import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const root = join(import.meta.dir, '..');
const defaults = join(root, '.archon', 'workflows', 'defaults');
const source = YAML.parse(
  readFileSync(join(defaults, 'bdc-feature-development-zero-open.yaml'), 'utf8')
) as Record<string, unknown>;

const roles = {
  'check-already-satisfied': 'precheck',
  plan: 'planner',
  'plan-review': 'reviewer',
  implement: 'builder',
  'war-council-validator': 'judge',
  'diff-review': 'reviewer',
  'diff-repair': 'builder',
  'diff-review-final': 'reviewer',
  'opus-repair': 'builder',
  'opus-rereview': 'reviewer',
  'findings-consolidate': 'clerical',
  'apply-suggested-fix': 'builder',
  'apply-diff-review-final': 'reviewer',
  'decide-push-target': 'clerical',
  'flip-notion': 'clerical',
  'flip-notion-on-failure': 'clerical',
} as const;
type Role = (typeof roles)[keyof typeof roles];

const toolsByRole: Record<Role, string[]> = {
  precheck: ['bash', 'read_file', 'list_dir'],
  planner: ['read_file', 'list_dir'],
  reviewer: ['read_file', 'list_dir', 'read_artifact'],
  builder: ['bash', 'read_file', 'write_file', 'edit_file', 'list_dir', 'read_artifact'],
  judge: ['read_file', 'list_dir', 'read_artifact'],
  clerical: [],
};
// The provider stops between requests when OpenRouter-reported cost reaches the
// node guard. A spend-limited staging key is still required for a hard account cap.
const budgetByRole: Record<Role, number> = {
  precheck: 0.1,
  planner: 0.2,
  reviewer: 0.4,
  builder: 1.5,
  judge: 0.75,
  clerical: 0.08,
};

const variants = {
  a: { reviewer: 'z-ai/glm-5.3', judge: 'moonshotai/kimi-k3' },
  b: { reviewer: 'moonshotai/kimi-k3', judge: 'z-ai/glm-5.3' },
} as const;

for (const [variant, roster] of Object.entries(variants)) {
  const workflow = structuredClone(source) as Record<string, unknown> & {
    nodes: Record<string, unknown>[];
  };
  workflow.name = `bdc-feature-development-open-${variant}`;
  workflow.description =
    `Fixed OpenRouter lane ${variant.toUpperCase()}. Flash plans, V4 Pro builds, ` +
    `${roster.reviewer} reviews, and ${roster.judge} judges. ` +
    'Staging candidate; production routing requires a separate board ruling.';
  workflow.provider = 'openrouter';
  workflow.model = 'deepseek/deepseek-v4.1-flash';

  const found = new Set<string>();
  for (const node of workflow.nodes) {
    if (typeof node.prompt !== 'string' && typeof node.loop !== 'object') continue;
    const id = String(node.id);
    const role = roles[id as keyof typeof roles];
    if (!role) throw new Error(`Unclassified AI node: ${id}`);
    found.add(id);
    node.provider = 'openrouter';
    node.model =
      role === 'builder'
        ? 'deepseek/deepseek-v4-pro-0813'
        : role === 'reviewer'
          ? roster.reviewer
          : role === 'judge'
            ? roster.judge
            : 'deepseek/deepseek-v4.1-flash';
    node.allowed_tools = toolsByRole[role];
    node.maxBudgetUsd = budgetByRole[role];
    delete node.failover_provider;
    delete node.failover_model;
    delete node.fallbackModel;
    if (node.agent === 'codex-adversarial-reviewer') node.agent = 'opr-adversarial-reviewer';

    if (id === 'war-council-validator') {
      node.prompt = (node.prompt as string).replace(
        /## Test execution contract[\s\S]*?## Required Output/,
        '## Test and diff evidence contract\n' +
          'The harness independently ran run-stop-tests and run-stop-greps after the builder.\n' +
          'Inspect their outputs and relevant test source. Do not claim you ran a command.\n' +
          'Report TESTS_OBSERVED: <passed>/<total> (<harness command>) when the mechanical\n' +
          'output contains parseable counts; otherwise report TESTS_OBSERVED: not_run\n' +
          '(<reason>) and return needs_revision. Every failed test or grep is a finding.\n' +
          'Read diff.patch with read_artifact and inspect changed files with read_file.\n' +
          'If the diff artifact is missing or unreadable, return needs_revision.\n\n' +
          '## Required Output'
      );
    }
    if (id === 'plan-review') {
      const loop = node.loop as { prompt?: string };
      loop.prompt = (loop.prompt ?? '')
        .replace(
          'Spec: $read-spec.output',
          'Spec: $read-spec.output\nRepair target preflight: $checkout-repair-target.output'
        )
        .replace(
          'use WebFetch to verify that PR #N is open',
          'use the repair target preflight to verify that PR #N is open'
        );
    }
    if (typeof node.prompt === 'string') {
      node.prompt = node.prompt
        .replaceAll('Codex diff reviewer', 'OpenRouter diff reviewer')
        .replaceAll('Codex adversarial reviewer', 'OpenRouter adversarial reviewer')
        .replaceAll('Codex review verdict', 'OpenRouter review verdict')
        .replaceAll('Codex findings', 'review findings')
        .replaceAll('Codex does not edit', 'the reviewer does not edit');
    }
  }
  const missing = Object.keys(roles).filter(id => !found.has(id));
  if (missing.length) throw new Error(`Missing AI nodes: ${missing.join(', ')}`);

  const get = (id: string): Record<string, unknown> => {
    const node = workflow.nodes.find(candidate => candidate.id === id);
    if (!node) throw new Error(`Missing DAG node: ${id}`);
    return node;
  };
  const capture = get('capture-diff');
  capture.depends_on = ['ascii-gate', 'run-stop-tests', 'run-stop-greps', 'resolve-review-base'];
  get('war-council-validator').depends_on = [
    'ascii-gate',
    'run-stop-tests',
    'run-stop-greps',
    'capture-diff',
  ];
  const diffReview = get('diff-review');
  diffReview.prompt = (diffReview.prompt as string)
    .replace(
      'You are the Codex adversarial diff reviewer.',
      'You are the OpenRouter adversarial diff reviewer.'
    )
    .replace(
      /READ the captured diff[\s\S]*?for fuller context\./,
      'Call read_artifact with path diff.patch. If it is missing or truncated, return needs_revision. ' +
        'Use read_file and list_dir on the changed files for fuller context.'
    );
  const diffReviewFinal = get('diff-review-final');
  diffReviewFinal.prompt = (diffReviewFinal.prompt as string)
    .replace(
      'You are the Codex adversarial reviewer',
      'You are the OpenRouter adversarial reviewer'
    )
    .replace(
      'You have no Bash tool -- do not run git; read that file.)',
      'Call read_artifact with path diff-final.patch. Missing or truncated evidence means needs_revision.)'
    );

  const addCapture = (id: string, after: string, when: string, artifact: string): void => {
    const node = structuredClone(capture);
    node.id = id;
    node.depends_on = [after, 'resolve-review-base'];
    node.trigger_rule = 'all_done';
    node.when = when;
    node.bash = (node.bash as string).replaceAll('diff.patch', artifact);
    const insertAt = workflow.nodes.findIndex(candidate => candidate.id === after) + 1;
    workflow.nodes.splice(insertAt, 0, node);
  };
  addCapture(
    'capture-opus-diff',
    'classify-opus-repair',
    "$classify-opus-repair.output.fixed == 'true'",
    'opus-diff.patch'
  );
  const opusRereview = get('opus-rereview');
  opusRereview.depends_on = ['classify-opus-repair', 'capture-opus-diff'];
  opusRereview.prompt = (opusRereview.prompt as string).replace(
    'Confirm the build now satisfies the WO',
    'Call read_artifact with path opus-diff.patch; missing or truncated evidence means needs_revision. ' +
      'Confirm the build now satisfies the WO'
  );

  addCapture(
    'capture-apply-diff',
    'apply-suggested-fix',
    "$pause-gate.output.decision_verb == 'approve_with_fix'",
    'apply-diff.patch'
  );
  const applyRereview = get('apply-diff-review-final');
  applyRereview.depends_on = ['apply-suggested-fix', 'capture-apply-diff'];
  applyRereview.prompt = (applyRereview.prompt as string).replace(
    'Read-only. Verify the fix matches',
    'Read-only. Call read_artifact with path apply-diff.patch; missing or truncated evidence means needs_revision. Verify the fix matches'
  );

  const manifest = get('build-manifest');
  manifest.legacy_prompt = (manifest.legacy_prompt as string)
    .replaceAll('Diff review (Codex, initial)', 'Diff review (OpenRouter, initial)')
    .replaceAll(
      'Diff review (Codex, final after repair)',
      'Diff review (OpenRouter, final after repair)'
    )
    .replaceAll('codex cross-model, OR paid-seat-fallback', 'openrouter cross-model');

  const output = YAML.stringify(workflow, { lineWidth: 0 });
  writeFileSync(join(defaults, `${workflow.name}.yaml`), output, 'utf8');
}
