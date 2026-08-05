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
if (!configured || configured.kind !== 'acp') {
  throw new Error(`unknown_or_non_acp_seat: ${seatId}`);
}

const cwd = argument('--cwd') ?? process.cwd();
const seat: SeatUnderTest = { id: seatId, config: configured, cwd };
const shortTimeoutConfig: AgentConfig = {
  ...configured,
  args: [...configured.args],
  acp: {
    ...configured.acp,
    idleTimeoutMs: Number(argument('--timeout-ms') ?? 5_000),
    wallClockMs: Number(argument('--timeout-ms') ?? 5_000),
    killGraceMs: configured.acp?.killGraceMs ?? ACP_DEFAULT_KILL_GRACE_MS,
  },
};
const failureCommand = argument('--failure-command');
const forcedFailureSeat: SeatUnderTest = failureCommand
  ? {
      id: `${seatId}-forced-failure`,
      config: { ...shortTimeoutConfig, command: failureCommand, args: [] },
      cwd,
    }
  : { id: `${seatId}-forced-failure`, config: shortTimeoutConfig, cwd };

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
        idleTimeoutMs: configured.acp?.idleTimeoutMs ?? ACP_DEFAULT_IDLE_TIMEOUT_MS,
        wallClockMs: configured.acp?.wallClockMs ?? ACP_DEFAULT_WALL_CLOCK_MS,
      },
      report,
    },
    null,
    2
  )
);

process.exitCode = report.allGreen ? 0 : 1;
