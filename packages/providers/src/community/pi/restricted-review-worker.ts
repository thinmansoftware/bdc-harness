// Dedicated one-review process entrypoint. Never import from a shared server.
import { createRestrictedReviewFetch } from './restricted-review-transport';
import { REVIEW_REF } from './restricted-review-policy';

if (
  process.platform !== 'linux' ||
  process.cwd() !== '/workspace' ||
  process.env.TEE_TIME_REVIEW_WORKER !== '1'
)
  throw new Error('dedicated review worker required');
for (const [key, value] of Object.entries(process.env)) {
  if (value && /(?:TOKEN|SECRET|API_KEY|PROXY)/i.test(key))
    throw new Error('review worker inherited forbidden environment');
}
let prompt = '';
let inputBytes = 0;
const decoder = new TextDecoder('utf-8', { fatal: true });
for await (const chunk of Bun.stdin.stream()) {
  inputBytes += chunk.byteLength;
  prompt += decoder.decode(chunk, { stream: true });
  if (inputBytes > 12000) throw new Error('review input exceeds bound');
}
prompt += decoder.decode();
// Installed before any Pi/OpenAI import, for this process lifetime only.
globalThis.fetch = createRestrictedReviewFetch(globalThis.fetch.bind(globalThis));
const piModule = await import('./provider');
const provider = new piModule.PiProvider(true);
for await (const chunk of provider.sendQuery(prompt, '/workspace', undefined, {
  model: REVIEW_REF,
})) {
  console.log(JSON.stringify(chunk));
}
