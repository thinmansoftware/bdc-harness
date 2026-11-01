/**
 * Startup catch-up for App webhook deliveries that arrived while the server
 * was down. GitHub does not redeliver those on its own. This pass asks the
 * App delivery API to try again, then the existing review route ingests them.
 * It never throws: a failure must not reject server startup.
 */
import { createLogger } from '@archon/paths';
import { buildAppJwt, type GitHubAppIdentity } from '@archon/core/github/service-identity';
import { resolveGitHubAppAuth, type GitHubAppAuthConfig } from './adapters/github-real-deps';
import type { ReviewRouteConfig } from './pr-review-wiring';
import { hasIngestReceiptForDelivery, latestIngestReceiptAt } from './review-ingest-receipts';

const log = createLogger('overseer/review-webhook-catchup');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REDELIVERIES = 200;
const MAX_PAGES = 10;
const MAX_INSPECTED = 1000;
const DELIVERIES_URL = 'https://api.github.com/app/hook/deliveries?per_page=100';

/**
 * Wall-clock instant the current process started.
 *
 * `process.uptime()` grows with the clock, so this stays at process start
 * even when it is read after a long startup.
 */
export function containerStartedAtMs(nowMs: number = Date.now()): number {
  return nowMs - process.uptime() * 1000;
}

export interface CatchupLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

export interface WebhookRedeliveryCatchupDeps {
  fetch?: typeof fetch;
  /** Test seam. Production mints a JWT and never logs it. */
  authorizationHeader?: string;
  now?: () => number;
  /**
   * Process start, not the moment the HTTP listener becomes ready. When
   * omitted, the window anchors on process start so a startup longer than
   * the 10-minute lookback still includes deliveries from early in startup.
   */
  containerStartedAt?: number;
  latestIngestReceiptAt?: () => Promise<Date | null>;
  hasIngestReceiptForDelivery?: (guid: string) => Promise<boolean>;
  resolveAppAuth?: () => GitHubAppAuthConfig | null;
  log?: CatchupLogger;
}

interface AppHookDelivery {
  id?: unknown;
  guid?: unknown;
  delivered_at?: unknown;
  status?: unknown;
  event?: unknown;
}

function safeErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : 'unknown_error';
  if (/bearer\s|private key|begin [a-z0-9 ]*private/i.test(text)) return 'redacted_error';
  return text;
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: authorization,
    'User-Agent': 'bdc-harness-webhook-catchup',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

function numericId(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function prNumberFromDetail(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { request?: { payload?: unknown }; payload?: unknown };
  const payload = record.request?.payload ?? record.payload;
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as { number?: unknown; pull_request?: { number?: unknown } };
  const value = numericId(event.number) ?? numericId(event.pull_request?.number);
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function resolveAuthorization(
  deps: WebhookRedeliveryCatchupDeps,
  logger: CatchupLogger
): Promise<string | null> {
  if (deps.authorizationHeader) return deps.authorizationHeader;
  try {
    const resolve = deps.resolveAppAuth ?? resolveGitHubAppAuth;
    const auth = resolve();
    if (!auth) {
      logger.info({ reason: 'app_auth_absent' }, 'webhook_catchup_skipped');
      return null;
    }
    const identity: GitHubAppIdentity = {
      kind: 'app',
      service: 'overseer',
      appId: auth.appId,
      installationId: auth.installationId,
      privateKey: auth.privateKey,
      poolId: 'overseer',
      distinct: true,
    };
    return `Bearer ${buildAppJwt(identity)}`;
  } catch (error) {
    logger.warn({ err: safeErrorText(error) }, 'webhook_catchup_skipped');
    return null;
  }
}

async function readPullRequestNumber(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  id: number
): Promise<number | null> {
  try {
    const detail = await fetchImpl(`https://api.github.com/app/hook/deliveries/${id}`, {
      method: 'GET',
      headers,
    });
    if (!detail.ok) return null;
    return prNumberFromDetail(await readJson(detail));
  } catch {
    return null;
  }
}

/**
 * Redeliver recent pull_request deliveries that failed or have no ingest
 * receipt. Bounds: 200 redelivery POSTs and 10 pages / 1000 inspected
 * deliveries. Pagination stops when a page is entirely older than the window.
 */
export async function runWebhookRedeliveryCatchup(
  config: ReviewRouteConfig,
  deps: WebhookRedeliveryCatchupDeps = {}
): Promise<void> {
  const logger = deps.log ?? log;
  try {
    if (!config.webhookSecret || !config.reviewerIdentity) {
      logger.info({ reason: 'review_route_unconfigured' }, 'webhook_catchup_skipped');
      return;
    }
    const authorization = await resolveAuthorization(deps, logger);
    if (!authorization) return;

    const nowMs = deps.now?.() ?? Date.now();
    const containerStartedAt = deps.containerStartedAt ?? containerStartedAtMs(nowMs);
    const latest = await (deps.latestIngestReceiptAt ?? latestIngestReceiptAt)();
    const anchorMs = latest?.getTime() ?? containerStartedAt;
    if (!Number.isFinite(anchorMs)) {
      logger.warn({ reason: 'window_anchor_invalid' }, 'webhook_catchup_skipped');
      return;
    }
    const windowStart = anchorMs - WINDOW_MS;
    const fetchImpl = deps.fetch ?? fetch;
    const hasReceipt = deps.hasIngestReceiptForDelivery ?? hasIngestReceiptForDelivery;
    const headers = githubHeaders(authorization);

    let url: string | null = DELIVERIES_URL;
    let pages = 0;
    let inspected = 0;
    let redelivered = 0;

    while (
      url &&
      pages < MAX_PAGES &&
      redelivered < MAX_REDELIVERIES &&
      inspected < MAX_INSPECTED
    ) {
      pages += 1;
      const response = await fetchImpl(url, { method: 'GET', headers });
      if (!response.ok) {
        logger.warn({ status: response.status, page: pages }, 'webhook_catchup_list_failed');
        return;
      }
      const body = await readJson(response);
      if (!Array.isArray(body)) {
        logger.warn({ page: pages }, 'webhook_catchup_list_invalid');
        return;
      }
      if (body.length === 0) return;

      let pageHasInWindow = false;
      let capped = false;
      for (const entry of body) {
        if (redelivered >= MAX_REDELIVERIES || inspected >= MAX_INSPECTED) {
          capped = true;
          break;
        }
        inspected += 1;
        const delivery = (entry ?? {}) as AppHookDelivery;
        const deliveredAt = Date.parse(text(delivery.delivered_at));
        if (!Number.isFinite(deliveredAt) || deliveredAt < windowStart) continue;
        pageHasInWindow = true;
        if (text(delivery.event) !== 'pull_request') continue;
        const id = numericId(delivery.id);
        const guid = text(delivery.guid);
        if (id === null || guid === '') continue;
        if (text(delivery.status) === 'OK' && (await hasReceipt(guid))) continue;

        let prNumber: number | null = null;
        try {
          prNumber = await readPullRequestNumber(fetchImpl, headers, id);
          const attempt = await fetchImpl(
            `https://api.github.com/app/hook/deliveries/${id}/attempts`,
            { method: 'POST', headers }
          );
          if (!attempt.ok) {
            logger.warn(
              { deliveryId: id, guid, status: attempt.status },
              'webhook_redeliver_failed'
            );
          } else {
            logger.info({ deliveryId: id, guid, prNumber }, 'webhook_redelivered');
          }
        } catch (error) {
          logger.warn(
            { deliveryId: id, guid, prNumber, err: safeErrorText(error) },
            'webhook_redeliver_failed'
          );
        }
        redelivered += 1;
      }

      if (capped || !pageHasInWindow) return;
      url = parseNextLink(response.headers.get('link'));
    }
  } catch (error) {
    logger.error({ err: safeErrorText(error) }, 'webhook_catchup_failed');
  }
}
