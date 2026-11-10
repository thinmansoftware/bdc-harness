// Run AFTER the authorized rebuild, as appuser in /app:
// bun run scripts/claude-model-probe.ts
// Uses the existing approved SDK profile. Never prints auth, prompts or raw errors.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { checkInstalledClaude } from './claude-version-guard';

const binary = checkInstalledClaude();
for (const model of ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-9-9']) {
  const bogus = model === 'claude-fable-9-9';
  let accepted = false;
  let rejectedModel = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 120_000);
  try {
    for await (const message of query({
      prompt: 'Reply exactly ONLINE. Do not use tools.',
      options: {
        model,
        tools: [],
        permissionMode: 'plan',
        persistSession: false,
        maxTurns: 1,
        pathToClaudeCodeExecutable: binary,
        abortController: controller,
      },
    })) {
      if (message.type === 'result') {
        accepted =
          !message.is_error &&
          message.subtype === 'success' &&
          Object.keys(message.modelUsage ?? {}).some(id => id.startsWith(model));
        rejectedModel =
          message.is_error &&
          /model_not_found|may not exist|selected model/.test(JSON.stringify(message));
      }
    }
  } catch (error) {
    rejectedModel = /model_not_found|may not exist|selected model/.test(String(error));
  } finally {
    clearTimeout(timer);
  }
  const pass = bogus ? rejectedModel && !accepted : accepted;
  console.log(JSON.stringify({ model, accepted, rejectedModel, pass }));
  if (!pass) process.exitCode = 1;
}
