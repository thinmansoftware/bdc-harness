import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { authenticateBoardPrincipal, getCurrentXoLease } from '@archon/core/db/board-authority';
import { AdviceLedger } from '../xo-advice/ledger';
import {
  AdviceService,
  OpenRouterAdviceClient,
  advicePacketSchema,
  type AdvicePrincipal,
} from '../xo-advice/service';

declare module 'hono' {
  interface ContextVariableMap {
    xoAdvicePrincipal: AdvicePrincipal;
  }
}
export interface AdviceRouteDeps {
  enabled?: boolean;
  authenticate?: (token: string | undefined) => Promise<AdvicePrincipal>;
  service?: AdviceService;
}
const response = {
  content: { 'application/json': { schema: z.unknown() } },
  description: 'Source-cited advice or explicit refusal; never execution authority',
};
const route = createRoute({
  method: 'post',
  path: '/api/board/xo-advice',
  tags: ['Board Authority'],
  summary: 'Staging-only XO advisory delegate (Terra; independent Sol on important decisions)',
  request: {
    body: { required: true, content: { 'application/json': { schema: advicePacketSchema } } },
  },
  responses: {
    200: response,
    400: response,
    401: response,
    409: response,
    429: response,
    503: response,
  },
});

/** Installed behind the existing private-API middleware. Never changes Board delivery. */
export function registerXoAdviceRoutes(app: OpenAPIHono, deps: AdviceRouteDeps = {}): void {
  // This phase cannot be enabled in a production process. Later activation needs
  // exact-head review and an approved deployment/adoption change.
  const enabled =
    deps.enabled ??
    (process.env.XO_ADVICE_MODE === 'staging' && process.env.NODE_ENV !== 'production');
  const authenticate =
    deps.authenticate ??
    (async (token: string | undefined): Promise<AdvicePrincipal> =>
      authenticateBoardPrincipal({ principal_token: token }));
  let service = deps.service;
  app.use(route.path, bodyLimit({ maxSize: 96_000 }));
  app.use(route.path, async (c, next) => {
    if (!enabled) return c.json({ error: 'xo_advice_disabled' }, 503);
    try {
      const principal = await authenticate(c.req.header('x-board-principal-token'));
      if (principal.seat_id !== 'xo') return c.json({ error: 'xo_principal_required' }, 401);
      c.set('xoAdvicePrincipal', principal);
    } catch {
      return c.json({ error: 'board_principal_auth_rejected' }, 401);
    }
    return next();
  });
  app.openapi(
    route,
    async c => {
      try {
        if (!service) {
          const file = process.env.XO_ADVICE_LEDGER_PATH;
          const key = process.env.OPENROUTER_API_KEY;
          if (!file || !key) return c.json({ error: 'xo_advice_unconfigured' }, 503);
          const client = new OpenRouterAdviceClient(key);
          service = new AdviceService(new AdviceLedger(file), client, getCurrentXoLease);
        }
        return c.json(await service.run(c.req.valid('json'), c.get('xoAdvicePrincipal')), 200);
      } catch (error) {
        const code =
          error instanceof Error && /^[a-z_]+$/.test(error.message)
            ? error.message
            : 'xo_advice_failed';
        const status =
          code === 'pilot_cap'
            ? 429
            : code === 'duplicate_request' || code === 'stale_xo_lease'
              ? 409
              : 503;
        return c.json({ error: code, advice_only: true }, status);
      }
    },
    (result, c) => {
      if (!result.success) return c.json({ error: 'invalid_advice_packet' }, 400);
      return undefined;
    }
  );
}
