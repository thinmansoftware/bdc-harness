import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import {
  buildAgentInvocation,
  defaultAgentConfigs,
  PROMPT_FILE_PLACEHOLDER,
  type AgentConfig,
} from './adapters';
import { runAgent } from './index';

// Matches the literal prompt template token in any case with optional inner
// whitespace, e.g. `{{prompt}}` or `{{ Prompt }}`. Used only for ASSERTIONS
// here -- the production guard lives in adapters.ts.
const TOKEN_RE = /\{\{\s*prompt\s*\}\}/i;

function message(body: string, recipient: string) {
  return {
    id: `prompt-token-${recipient}-${Date.now()}`,
    task_type: 'agent_message' as const,
    sender: 'test',
    recipient,
    body,
    status: 'claimed' as const,
    fencing_token: 1,
  };
}

/**
 * A stub CLI that records the argv it was launched with and the full prompt it
 * received on stdin, writing them as JSON to the path in the STUB_OUT env var.
 * `extraArgs` become argv AFTER the script path (so they reach the stub, not the
 * runtime), mirroring the shape of a real seat's `args`.
 */
async function argvStdinRecorder(
  extraArgs: string[]
): Promise<{ config: AgentConfig; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-token-'));
  const outPath = join(dir, 'capture.json');
  const script = join(dir, 'record.cjs');
  await writeFile(
    script,
    "const fs = require('fs');\n" +
      'const chunks = [];\n' +
      "process.stdin.on('data', c => chunks.push(c));\n" +
      "process.stdin.on('end', () => {\n" +
      '  fs.writeFileSync(process.env.STUB_OUT, JSON.stringify({\n' +
      '    argv: process.argv.slice(2),\n' +
      "    stdin: Buffer.concat(chunks).toString('utf8'),\n" +
      '  }));\n' +
      "  process.stdout.write('ROUND_TRIP_OK');\n" +
      '});\n',
    'utf8'
  );
  const config: AgentConfig = {
    command: process.execPath,
    args: [script, ...extraArgs],
    env: { STUB_OUT: outPath },
  };
  return { config, outPath };
}

async function readCapture(outPath: string): Promise<{ argv: string[]; stdin: string }> {
  return JSON.parse(await readFile(outPath, 'utf8'));
}

describe('WO-HARNESS-DISPATCH-WORKER-PROMPT-TOKEN-01 -- prompt template token', () => {
  // Test 1: token_arg_is_dropped_for_every_seat_in_the_example_config
  test('token_arg_is_dropped_for_every_seat_in_the_example_config', () => {
    const parsed = JSON.parse(
      readFileSync(new URL('./config.example.json', import.meta.url), 'utf8')
    ) as { agents: Record<string, AgentConfig> };

    for (const [name, entry] of Object.entries(parsed.agents)) {
      if ((entry.kind ?? 'prompt') !== 'prompt') continue;
      const before = [...entry.args];
      const out = buildAgentInvocation(entry, 'hello').args;
      expect(
        out.some(arg => TOKEN_RE.test(arg)),
        `${name} argv must contain no token`
      ).toBe(false);
      // Every non-token arg is preserved, in order.
      expect(out).toEqual(before.filter(arg => !TOKEN_RE.test(arg)));
    }

    // Synthetic configs that still carry the token (lower- and mixed-case with
    // inner spaces) have it dropped while the real flag is preserved in order.
    for (const tokenArg of ['{{prompt}}', '{{ Prompt }}']) {
      const synthetic: AgentConfig = { command: 'x', args: ['-p', tokenArg] };
      expect(buildAgentInvocation(synthetic, 'hello').args).toEqual(['-p']);
    }
  });

  // Test 2: spawned_child_argv_never_contains_the_literal_token_and_prompt_arrives_on_stdin
  test('spawned_child_argv_never_contains_the_literal_token_and_prompt_arrives_on_stdin', async () => {
    const { config, outPath } = await argvStdinRecorder(['-p', '{{prompt}}']);
    const body = 'line one\nline two';
    const result = await runAgent(config, message(body, 'claude'));

    expect(result.status).toBe('done');
    const capture = await readCapture(outPath);
    expect(capture.argv.some(arg => TOKEN_RE.test(arg))).toBe(false);
    expect(capture.stdin).toBe(body);
    expect(capture.stdin).toContain('line two');
  }, 15_000);

  // Test 3: embedded_token_fails_loudly_with_a_named_error
  test('embedded_token_fails_loudly_with_a_named_error', () => {
    const config: AgentConfig = { command: 'grok', args: ['--prompt={{prompt}}'] };
    expect(() => buildAgentInvocation(config, 'hello')).toThrow(
      'dispatch_agent_args_prompt_template_embedded'
    );
  });

  // Test 4: example_config_matches_adapter_defaults_and_has_no_token
  test('example_config_matches_adapter_defaults_and_has_no_token', () => {
    const raw = readFileSync(new URL('./config.example.json', import.meta.url), 'utf8');
    expect(TOKEN_RE.test(raw)).toBe(false);

    const parsed = JSON.parse(raw) as { agents: Record<string, AgentConfig> };
    expect(parsed.agents.claude.args).toEqual(defaultAgentConfigs.claude.args);
    expect(parsed.agents.codex.args).toEqual(defaultAgentConfigs.codex.args);
    expect(parsed.agents.cursor.args).toEqual(defaultAgentConfigs.cursor.args);
    expect(parsed.agents.grok.promptDelivery).toBe('prompt-file');
    expect(parsed.agents.grok.args).toContain(PROMPT_FILE_PLACEHOLDER);
  });

  // Test 5: two_line_agent_message_round_trip_per_prompt_kind_seat
  test('two_line_agent_message_round_trip_per_prompt_kind_seat', async () => {
    const body = 'first seat line\nsecond seat line';
    for (const seat of ['claude', 'codex', 'cursor']) {
      // Pre-fix config shape: the seat's real flags PLUS a stray token arg.
      const strayArgs = [...defaultAgentConfigs[seat].args, '{{prompt}}'];
      const { config, outPath } = await argvStdinRecorder(strayArgs);
      const result = await runAgent(config, message(body, seat));

      expect(result.status, `${seat} should complete`).toBe('done');
      const capture = await readCapture(outPath);
      expect(
        capture.argv.some(arg => TOKEN_RE.test(arg)),
        `${seat} argv must drop token`
      ).toBe(false);
      expect(capture.stdin, `${seat} stdin must carry the full body`).toBe(body);
      expect(capture.stdin).toContain('second seat line');
    }
  }, 30_000);

  // Test 6: prompt_file_placeholder_is_not_touched_by_the_guard
  test('prompt_file_placeholder_is_not_touched_by_the_guard', () => {
    const config: AgentConfig = {
      command: 'grok',
      args: ['--prompt-file', PROMPT_FILE_PLACEHOLDER],
      promptDelivery: 'prompt-file',
    };
    const out = buildAgentInvocation(config, 'irrelevant').args;
    expect(out).toEqual(['--prompt-file', PROMPT_FILE_PLACEHOLDER]);
    expect(out).toContain(PROMPT_FILE_PLACEHOLDER);
  });
});
