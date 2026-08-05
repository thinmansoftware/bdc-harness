import {
  ACP_DEFAULT_IDLE_TIMEOUT_MS,
  ACP_DEFAULT_KILL_GRACE_MS,
  ACP_DEFAULT_WALL_CLOCK_MS,
  defaultAgentConfigs,
  type AgentConfig,
} from './adapters';
import { runConformanceMatrix, type SeatUnderTest } from './acp/conformance';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const seatId = argument('--seat') ?? 'grok-acp';
const configured = defaultAgentConfigs[seatId];
if (configured?.kind !== 'acp' && configured?.kind !== 'mcp') {
  throw new Error(`unknown_or_non_conformance_seat: ${seatId}`);
}

const cwd = argument('--cwd') ?? process.cwd();
const seat: SeatUnderTest = { id: seatId, config: configured, cwd };
const timeoutMs = Number(argument('--timeout-ms') ?? 5_000);
const shortTimeoutConfig: AgentConfig =
  configured.kind === 'mcp'
    ? {
        ...configured,
        args: [...configured.args],
        mcp: {
          ...configured.mcp,
          idleTimeoutMs: timeoutMs,
          wallClockMs: timeoutMs,
          killGraceMs: configured.mcp?.killGraceMs ?? ACP_DEFAULT_KILL_GRACE_MS,
        },
      }
    : {
        ...configured,
        args: [...configured.args],
        acp: {
          ...configured.acp,
          idleTimeoutMs: timeoutMs,
          wallClockMs: timeoutMs,
          killGraceMs: configured.acp?.killGraceMs ?? ACP_DEFAULT_KILL_GRACE_MS,
        },
      };
// Default to a command that cannot possibly start (Windows-safe: no shell
// resolution needed, ENOENT is immediate). Without this, "forced failure" was
// just the real agent hitting the idle/wall timeout -- which the session
// classifies as cancelled, not failed, so the test never exercised an actual
// failure path. --failure-command still overrides for a different failure shape.
const failureCommand = argument('--failure-command') ?? '__bdc_conformance_nonexistent_binary__';
const forcedFailureSeat: SeatUnderTest = {
  id: `${seatId}-forced-failure`,
  config: { ...shortTimeoutConfig, command: failureCommand, args: [] },
  cwd,
};

const report = await runConformanceMatrix(seat, {
  cancellationSeat: { id: `${seatId}-cancel`, config: shortTimeoutConfig, cwd },
  forcedFailureSeat,
  timeoutSeat: { id: `${seatId}-timeout`, config: shortTimeoutConfig, cwd },
  cancelAfterMs: Number(argument('--cancel-after-ms') ?? 1_000),
});

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      defaults: {
        idleTimeoutMs:
          (configured.kind === 'mcp'
            ? configured.mcp?.idleTimeoutMs
            : configured.acp?.idleTimeoutMs) ?? ACP_DEFAULT_IDLE_TIMEOUT_MS,
        wallClockMs:
          (configured.kind === 'mcp' ? configured.mcp?.wallClockMs : configured.acp?.wallClockMs) ??
          ACP_DEFAULT_WALL_CLOCK_MS,
      },
      report,
    },
    null,
    2
  )
);

process.exitCode = report.allGreen ? 0 : 1;
