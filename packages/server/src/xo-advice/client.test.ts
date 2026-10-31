import { expect, test } from 'bun:test';
import { OpenRouterAdviceClient, TERRA } from './service';

test('reserves only exact endpoint rates including peak override, excluding ultrafast', async () => {
  const fetcher = (async () =>
    Response.json({
      data: {
        endpoints: [
          {
            tag: 'openai',
            pricing: {
              prompt: '0.000001',
              completion: '0.000005',
              overrides: [{ prompt: '0.000002', completion: '0.0000075' }],
            },
          },
          { tag: 'openai/ultrafast', pricing: { prompt: '1', completion: '1' } },
        ],
      },
    })) as typeof fetch;
  const client = new OpenRouterAdviceClient('synthetic-test-only', fetcher);
  expect(await client.prices(TERRA)).toEqual({ prompt: 0.000002, completion: 0.0000075 });
  await expect(client.prices('another-model')).rejects.toThrow('advice_model_refused');
});
test('malformed pricing, missing exact endpoint and HTTP failures fail closed', async () => {
  const client = new OpenRouterAdviceClient('synthetic-test-only', (async () =>
    Response.json({ data: { endpoints: [] } })) as typeof fetch);
  await expect(client.prices(TERRA)).rejects.toThrow();
  const failure = new OpenRouterAdviceClient(
    'synthetic-test-only',
    (async () => new Response('', { status: 503 })) as typeof fetch
  );
  await expect(failure.receipt('gen-test')).rejects.toThrow('advice_provider_http_503');
});
