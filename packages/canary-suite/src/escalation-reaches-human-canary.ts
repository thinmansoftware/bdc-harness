import {
  failResult,
  passResult,
  type OutcomeCanaryDeps,
  type OutcomeCanaryResult,
} from './outcome-canary';

export type HumanArtifactKind = 'issue_comment' | 'operator_dispatch';

export interface HumanArtifact {
  readonly kind: HumanArtifactKind;
  readonly body: string;
}

export interface EscalationReachesHumanCanaryDeps extends OutcomeCanaryDeps {
  readonly deliver?: (fetcher: typeof fetch) => Promise<readonly HumanArtifact[]>;
  readonly artifacts?: readonly HumanArtifact[];
  readonly fetchLog?: readonly string[];
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export async function deliverNeedsHumanToOperator(
  _fetcher: typeof fetch
): Promise<readonly HumanArtifact[]> {
  return [
    {
      kind: 'operator_dispatch',
      body: 'needs_human: operator card dispatched to a human-readable surface',
    },
  ];
}

export async function deliverNeedsHumanViaNotion(
  fetcher: typeof fetch
): Promise<readonly HumanArtifact[]> {
  await fetcher('https://api.notion.com/v1/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return [];
}

export async function runEscalationReachesHumanCanary(
  deps: EscalationReachesHumanCanaryDeps
): Promise<OutcomeCanaryResult> {
  const fetchLog: string[] = [...(deps.fetchLog ?? [])];
  const artifacts: HumanArtifact[] = [...(deps.artifacts ?? [])];
  const inner = deps.fetcher ?? fetch;
  const spy = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    fetchLog.push(urlOf(input));
    return inner(input, init);
  }) as typeof fetch;
  const deliver = deps.deliver ?? deliverNeedsHumanToOperator;
  artifacts.push(...(await deliver(spy)));
  const notionHit = fetchLog.find(url => url.includes('api.notion.com'));
  if (notionHit) {
    return failResult('c3_escalation_notion_write_attempted', [`url=${notionHit}`]);
  }
  const human = artifacts.find(
    artifact => artifact.kind === 'issue_comment' || artifact.kind === 'operator_dispatch'
  );
  if (!human) {
    return failResult('c3_escalation_no_human_artifact', ['artifacts=0']);
  }
  return passResult([`artifact_kind=${human.kind}`, `fetch_log_size=${fetchLog.length}`]);
}
