import { randomUUID } from 'crypto';
import { buildDispatchRunReportBody, runEscalation } from '@archon/overseer/escalate';
import {
  createDefaultOperatorCardChannels,
  runDueOperatorCardDeliveries,
  type ChannelDeliveryResult,
  type OperatorCardChannel,
  type OperatorCardChannelDeps,
} from '@archon/overseer/escalation-delivery';
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

function recordDispatchArtifacts(
  channels: readonly OperatorCardChannel[],
  artifacts: HumanArtifact[]
): OperatorCardChannel[] {
  return channels.map((channel): OperatorCardChannel => {
    if (channel.channel !== 'dispatch') return channel;
    return {
      channel: 'dispatch',
      async deliver(
        card: Parameters<OperatorCardChannel['deliver']>[0],
        key: string
      ): Promise<ChannelDeliveryResult> {
        const result = await channel.deliver(card, key);
        if (result.outcome === 'succeeded') {
          artifacts.push({
            kind: 'operator_dispatch',
            body: buildDispatchRunReportBody(card.card),
          });
        }
        return result;
      },
      reconcile(
        card: Parameters<OperatorCardChannel['reconcile']>[0],
        attempt: number
      ): Promise<ChannelDeliveryResult> {
        return channel.reconcile(card, attempt);
      },
    };
  });
}

async function deliverNeedsHumanThroughProductionPath(
  fetcher: typeof fetch,
  channelOverrides: Partial<OperatorCardChannelDeps>
): Promise<readonly HumanArtifact[]> {
  const artifacts: HumanArtifact[] = [];
  const runId = `c3-canary-${randomUUID()}`;
  await runEscalation(
    runId,
    { decision: 'escalate', reason: 'needs_human' },
    {
      errorClass: 'unknown',
      woId: 'WO-C3-CANARY',
      repository: 'thinmansoftware/bdc-harness',
    },
    {
      sourceEventId: `event-${runId}`,
      eventType: 'node_failed',
      stepName: 'verify',
      eventCreatedAt: new Date().toISOString(),
    }
  );
  const channels = createDefaultOperatorCardChannels({
    fetch: fetcher,
    resolve_owner: async (): Promise<string | null> => 'operator',
    builder_monitor_url: 'https://c3-canary.invalid/builder-monitor',
    ...channelOverrides,
  });
  await runDueOperatorCardDeliveries({
    channels: recordDispatchArtifacts(channels, artifacts),
    owner: 'c3-canary',
  });
  return artifacts;
}

export async function deliverNeedsHumanToOperator(
  fetcher: typeof fetch
): Promise<readonly HumanArtifact[]> {
  return deliverNeedsHumanThroughProductionPath(fetcher, {});
}

export async function deliverNeedsHumanViaNotion(
  fetcher: typeof fetch
): Promise<readonly HumanArtifact[]> {
  return deliverNeedsHumanThroughProductionPath(fetcher, {
    notion_api_key: 'c3-canary-notion-key',
    notion_database_id: 'c3-canary-notion-db',
  });
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
