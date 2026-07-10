import { join } from 'path';
import { loadBaseline } from './baseline-loader';
import { escalateCriticalFindings, type TelegramSender } from './escalate';
import { reduceFindings } from './reducer';
import { writeSecurityWatchdogArtifacts } from './report';
import type { Baseline, Finding, ModuleId, ScanReport } from './types';

export type ModuleScanner = (baseline: Baseline) => Promise<readonly Finding[]>;

export interface RunScanOptions {
  readonly baselineRoot?: string;
  readonly outputRoot?: string;
  readonly runId?: string;
  readonly module?: ModuleId;
  readonly scanners?: Partial<Record<ModuleId, ModuleScanner>>;
  readonly telegramToken?: string;
  readonly telegramSender?: TelegramSender;
}

export interface RunScanResult {
  readonly report: ScanReport;
  readonly artifactPaths: readonly string[];
  readonly escalatedCriticals: number;
}

const MODULE_ORDER: readonly ModuleId[] = [
  'port-exposure',
  'secret-scan',
  'webhook-probe',
  'rls-anon-sweep',
  'world-readable',
  'legacy-twelve',
];

function defaultBaselineRoot(): string {
  return join(process.cwd(), 'packages/security-watchdog/baseline');
}

function defaultOutputRoot(): string {
  return join(process.cwd(), '.archon/security-watchdog-artifacts');
}

function missingScanner(module: ModuleId): ModuleScanner {
  return async () => {
    throw new Error(`scanner_client_required:${module}`);
  };
}

export async function runScan(options: RunScanOptions = {}): Promise<RunScanResult> {
  const baseline = await loadBaseline(options.baselineRoot ?? defaultBaselineRoot());
  const modules = options.module ? [options.module] : MODULE_ORDER;
  const findings: Finding[] = [];
  for (const module of modules) {
    const scanner = options.scanners?.[module] ?? missingScanner(module);
    findings.push(...(await scanner(baseline)));
  }
  const report = reduceFindings(
    findings,
    baseline,
    options.runId ?? `security-watchdog-${Date.now()}`
  );
  const artifactPaths = await writeSecurityWatchdogArtifacts(
    options.outputRoot ?? defaultOutputRoot(),
    report
  );
  const escalatedCriticals = await escalateCriticalFindings(report, {
    token: options.telegramToken,
    sender: options.telegramSender,
  });
  return { report, artifactPaths, escalatedCriticals };
}
