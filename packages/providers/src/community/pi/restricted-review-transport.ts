// Dedicated-process candidate only. Never install this in the shared harness.
import { REVIEW_ENDPOINT, REVIEW_MODEL } from './restricted-review-policy';

export function createRestrictedReviewFetch(upstream: typeof fetch): typeof fetch {
  let inferenceRequests = 0;
  let inventoryRequests = 0;
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin !== REVIEW_ENDPOINT || url.username || url.password || url.search || url.hash)
      throw new Error('restricted review transport destination rejected');
    if (url.pathname === '/api/tags' && request.method === 'GET') {
      if (++inventoryRequests > 2) throw new Error('review inventory request budget exhausted');
      if ([...request.headers.keys()].length) throw new Error('inventory headers rejected');
    } else if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      if (++inferenceRequests > 1) throw new Error('review inference request budget exhausted');
      for (const [key, value] of request.headers) {
        if (key === 'authorization') {
          if (value !== 'Bearer local-no-auth') throw new Error('unexpected review authorization');
        } else if (
          ![
            'accept',
            'content-type',
            'user-agent',
            'accept-encoding',
            'connection',
            'content-length',
          ].includes(key) &&
          !key.startsWith('x-stainless-')
        ) {
          throw new Error('unexpected review request header');
        }
      }
      const body = await request.clone().text();
      if (new TextEncoder().encode(body).length > 16000)
        throw new Error('serialized review request exceeds diagnostic bound');
      const data = JSON.parse(body);
      if (
        data.model !== REVIEW_MODEL ||
        data.stream !== true ||
        data.tools?.length ||
        data.functions?.length
      )
        throw new Error('unexpected review inference payload');
      // This bound is not proof of server context capacity. Admission remains closed.
    } else throw new Error('restricted review request path or method rejected');
    const response = await upstream(request, { redirect: 'error', signal: request.signal });
    if (response.status >= 300 && response.status < 400)
      throw new Error('review redirect rejected');
    if (!response.body) return response;
    let bytes = 0;
    const bounded = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller): void {
          bytes += chunk.byteLength;
          if (bytes > 131072) throw new Error('review transport response exceeds bound');
          controller.enqueue(chunk);
        },
      })
    );
    return new Response(bounded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}
