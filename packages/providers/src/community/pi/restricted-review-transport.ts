// Dedicated-process candidate only. Never install this in the shared harness.
import {
  REVIEW_ENDPOINT,
  REVIEW_MODEL,
  isRestrictedReviewSystem,
} from './restricted-review-policy';

// Private immutable wire contract. Callers cannot supply a replacement.
const REVIEW_RESPONSE_FORMAT_JSON =
  '{"type":"json_schema","json_schema":{"name":"tee_time_review","strict":true,"schema":{"type":"object","additionalProperties":false,"required":["verdict","reasons","evidenceIds"],"properties":{"verdict":{"type":"string","enum":["APPROVED","REJECTED"]},"reasons":{"type":"array","minItems":1,"maxItems":12,"items":{"type":"string","minLength":1,"maxLength":500}},"evidenceIds":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"string","enum":["spec","diff","tests"]}}}}}}';

export function createRestrictedReviewFetch(upstream: typeof fetch): typeof fetch {
  let inferenceRequests = 0;
  const inventoryRequests = new Map<string, number>();
  return (async (input: Request | string | URL, init?: RequestInit) => {
    let request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin !== REVIEW_ENDPOINT || url.username || url.password || url.search || url.hash)
      throw new Error('restricted review transport destination rejected');
    if (['/api/tags', '/api/ps'].includes(url.pathname) && request.method === 'GET') {
      const count = (inventoryRequests.get(url.pathname) ?? 0) + 1;
      inventoryRequests.set(url.pathname, count);
      if (count > 2) throw new Error('review inventory request budget exhausted');
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
      if (new TextEncoder().encode(body).length > 6000)
        throw new Error('serialized review request exceeds diagnostic bound');
      const data = JSON.parse(body);
      const allowed = new Set([
        'model',
        'messages',
        'stream',
        'stream_options',
        'max_tokens',
        'max_completion_tokens',
        'store',
        'tools',
      ]);
      if (
        Object.keys(data).some(key => !allowed.has(key)) ||
        ('store' in data && data.store !== false) ||
        ('max_tokens' in data && 'max_completion_tokens' in data)
      )
        throw new Error('unsupported review payload override');
      if (
        data.model !== REVIEW_MODEL ||
        data.stream !== true ||
        ('tools' in data && (!Array.isArray(data.tools) || data.tools.length !== 0)) ||
        'functions' in data ||
        'tool_choice' in data ||
        (data.max_tokens ?? data.max_completion_tokens) !== 1024
      )
        throw new Error('unexpected review inference payload');
      const userContent = data.messages?.[1]?.content;
      const textOnly =
        typeof userContent === 'string' ||
        (Array.isArray(userContent) &&
          userContent.length === 1 &&
          userContent[0]?.type === 'text' &&
          typeof userContent[0]?.text === 'string' &&
          Object.keys(userContent[0]).every(key => key === 'type' || key === 'text'));
      if (
        !Array.isArray(data.messages) ||
        data.messages.length !== 2 ||
        data.messages[0]?.role !== 'system' ||
        !isRestrictedReviewSystem(data.messages[0]?.content) ||
        data.messages[1]?.role !== 'user' ||
        !textOnly
      )
        throw new Error('restricted review system policy missing or changed');
      const wireBody = JSON.stringify({
        ...data,
        response_format: JSON.parse(REVIEW_RESPONSE_FORMAT_JSON),
        temperature: 0,
      });
      if (new TextEncoder().encode(wireBody).length > 6000)
        throw new Error('final review wire payload exceeds diagnostic bound');
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      request = new Request(request.url, {
        method: 'POST',
        headers,
        body: wireBody,
        signal: request.signal,
        redirect: 'error',
      });
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
