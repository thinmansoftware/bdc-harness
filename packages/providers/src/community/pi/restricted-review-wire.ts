import { REVIEW_MODEL, isRestrictedReviewSystem } from './restricted-review-policy';
import { createHash } from 'node:crypto';

// Private immutable wire contract. Callers cannot supply a replacement.
const REVIEW_RESPONSE_FORMAT_JSON =
  '{"type":"json_schema","json_schema":{"name":"tee_time_review","strict":true,"schema":{"type":"object","additionalProperties":false,"required":["verdict","reasons","evidenceIds"],"properties":{"verdict":{"type":"string","enum":["APPROVED","REJECTED"]},"reasons":{"type":"array","minItems":1,"maxItems":12,"items":{"type":"string","minLength":1,"maxLength":500}},"evidenceIds":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"string","enum":["spec","diff","tests"]}}}}}}';

export function buildRestrictedReviewWire(
  body: string,
  expectedPrompt?: string
): { body: string; bytes: number; schemaHash: string } {
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
  if (expectedPrompt !== undefined) {
    const actual = typeof userContent === 'string' ? userContent : userContent[0].text;
    if (actual !== expectedPrompt) throw new Error('wire package differs from frozen artifacts');
  }
  return {
    body: wireBody,
    bytes: new TextEncoder().encode(wireBody).length,
    schemaHash: createHash('sha256').update(REVIEW_RESPONSE_FORMAT_JSON).digest('hex'),
  };
}
