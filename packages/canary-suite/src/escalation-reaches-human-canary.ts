import { randomUUID } from 'crypto';
import { buildDispatchRunReportBody, runEscalation } from '@archon/overseer/escalate';
import {
  createDefaultOperatorCardChannels,
  runDueOperatorCardDeliveries,
  type ChannelDeliveryResult,
  type OperatorCardChannel,
  type OperatorCardChannelDeps,
} from '@archon/overseer/escalation-delivery';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabaseType, resetDatabase } from '@archon/core/db/connection';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import {
  blockedResult,
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
  /** Opt-in: the real escalation path persists an operator card and a dispatch row. */
  readonly c3SyntheticEscalation?: boolean;
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

/**
 * Switch the @archon/core DB singleton onto a throwaway sqlite file for the duration of
 * one delivery. Refuses when DATABASE_URL is set (getDatabase() would open Postgres);
 * closeDatabase()+resetDatabase() drop any live singleton; ARCHON_HOME points at a temp
 * dir so the next getDatabase() opens <temp>/archon.db; env and singleton are restored
 * afterwards and the temp dir removed. Proof of isolation before running: DATABASE_URL
 * still unset, getDatabaseType() === 'sqlite', ARCHON_HOME === the temp dir.
 */
async function withIsolatedSqliteStore<T>(
  run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; reason: 'c3_refused_production_store' }> {
  if ((process.env.DATABASE_URL ?? '').trim() !== '') {
    return { ok: false, reason: 'c3_refused_production_store' };
  }
  const previousHome = process.env.ARCHON_HOME;
  const isolatedHome = await mkdtemp(join(tmpdir(), 'c3-canary-'));
  await closeDatabase();
  resetDatabase();
  process.env.ARCHON_HOME = isolatedHome;
  try {
    if ((process.env.DATABASE_URL ?? '').trim() !== '' || getDatabaseType() !== 'sqlite') {
      return { ok: false, reason: 'c3_refused_production_store' };
    }
    if (process.env.ARCHON_HOME !== isolatedHome) {
      return { ok: false, reason: 'c3_refused_production_store' };
    }
    const value = await run();
    return { ok: true, value };
  } finally {
    await closeDatabase();
    resetDatabase();
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    removeTempDirWithRetry(isolatedHome);
  }
}

export async function runEscalationReachesHumanCanary(
  deps: EscalationReachesHumanCanaryDeps
): Promise<OutcomeCanaryResult> {
  if (!deps.c3SyntheticEscalation) {
    return blockedResult('c3_synthetic_escalation_not_enabled', ['flag=--c3-synthetic-escalation']);
  }
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
  const isolated = await withIsolatedSqliteStore(async () => deliver(spy));
  if (!isolated.ok) {
    return blockedResult(isolated.reason, ['store=production_or_unproven']);
  }
  artifacts.push(...isolated.value);
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
