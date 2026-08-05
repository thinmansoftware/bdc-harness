#!/usr/bin/env bun
/**
 * Executable entry for the BDC Claude ACP adapter (WO-HARNESS-CLAUDE-ACP-ADAPTER-01).
 *
 * Starts the agent-side ACP adapter on process stdio. The dispatch worker's
 * `claude-acp` seat (scripts/dispatch-worker/adapters.ts) invokes this file as
 * `bun run <abs path>/main.ts`; the prompt arrives over the ACP stream, never
 * as an argument to this process.
 */
import { runClaudeAcpAdapter } from './adapter';

runClaudeAcpAdapter().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`claude_acp_adapter_fatal: ${reason}\n`);
  process.exitCode = 1;
});
