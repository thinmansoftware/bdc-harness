import { expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerXoAdviceRoutes } from './xo-advice.routes';

test('route is dark by default and cannot spend without Board principal', async () => {
  const dark = new OpenAPIHono();
  registerXoAdviceRoutes(dark, { enabled: false });
  expect((await dark.request('/api/board/xo-advice', { method: 'POST' })).status).toBe(503);
  let auth = 0;
  const app = new OpenAPIHono();
  registerXoAdviceRoutes(app, {
    enabled: true,
    authenticate: async () => {
      auth++;
      throw new Error('board_principal_auth_rejected');
    },
  });
  expect(
    (
      await app.request('/api/board/xo-advice', {
        method: 'POST',
        headers: { Authorization: 'Bearer operator-only' },
      })
    ).status
  ).toBe(401);
  expect(auth).toBe(1);
});
test('valid identity does not accept arbitrary body or actor fields', async () => {
  const app = new OpenAPIHono();
  registerXoAdviceRoutes(app, {
    enabled: true,
    authenticate: async () => ({ principal_id: 'stage-xo', seat_id: 'xo' }),
  });
  const response = await app.request('/api/board/xo-advice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'synthetic' },
    body: JSON.stringify({ actor: 'xo' }),
  });
  expect(response.status).toBe(400);
});
