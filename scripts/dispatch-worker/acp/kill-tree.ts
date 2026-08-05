/**
 * Process-tree enumeration and bounded kill for the dispatch worker.
 *
 * WO-HARNESS-ACP-DISPATCH-SLICE-01 (M-118 ruling order 4): bounded
 * cancellation must actually kill Windows descendant processes, and the
 * proof must enumerate the tree before and after rather than assert.
 *
 * Windows is the primary target (the ruling's proof runs on John's Windows
 * machine). A best-effort POSIX fallback keeps tests runnable in CI.
 */
import { spawn } from 'node:child_process';

export interface ProcessNode {
  pid: number;
  ppid: number;
  name: string;
  /**
   * POSIX process state code from `ps` (e.g. 'S', 'R', 'Z'); empty string when
   * unknown (Windows, where CIM does not expose an equivalent single-letter
   * state). Used by waitForTreeDeath to treat zombie/defunct processes as dead.
   */
  state: string;
}

function runCapture(command: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.on('error', () => {
      resolve({ stdout: '', code: -1 });
    });
    child.on('close', code => {
      resolve({ stdout, code: code ?? -1 });
    });
  });
}

async function listAllProcesses(): Promise<ProcessNode[]> {
  if (process.platform === 'win32') {
    const { stdout } = await runCapture('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
    ]);
    try {
      const parsed = JSON.parse(stdout) as
        | { ProcessId: number; ParentProcessId: number; Name: string }[]
        | { ProcessId: number; ParentProcessId: number; Name: string };
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map(row => ({
        pid: row.ProcessId,
        ppid: row.ParentProcessId,
        name: row.Name ?? '',
        state: '',
      }));
    } catch {
      return [];
    }
  }
  // stat= is placed before comm= because a process name can contain spaces;
  // keeping the (single-token) state column ahead of the name keeps the split
  // unambiguous: [pid, ppid, state, ...name].
  const { stdout } = await runCapture('ps', ['-eo', 'pid=,ppid=,stat=,comm=']);
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [pid, ppid, state, ...name] = line.split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), state: state ?? '', name: name.join(' ') };
    })
    .filter(node => Number.isFinite(node.pid) && Number.isFinite(node.ppid));
}

/**
 * Returns the full descendant tree of `rootPid` (root included when alive),
 * computed from a point-in-time process snapshot.
 */
export async function enumerateProcessTree(rootPid: number): Promise<ProcessNode[]> {
  const all = await listAllProcesses();
  const byParent = new Map<number, ProcessNode[]>();
  for (const node of all) {
    const siblings = byParent.get(node.ppid) ?? [];
    siblings.push(node);
    byParent.set(node.ppid, siblings);
  }
  const result: ProcessNode[] = [];
  const rootNode = all.find(node => node.pid === rootPid);
  if (rootNode) result.push(rootNode);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    for (const child of byParent.get(parent) ?? []) {
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

/**
 * Force-kills a process and its full descendant tree.
 *
 * Windows: `taskkill /PID <pid> /T /F` -- the /T flag is the load-bearing
 * part; killing only the parent leaves grandchildren alive (the defect class
 * the M-118 ruling names). POSIX fallback kills the enumerated tree leaf-up.
 */
export async function killProcessTree(rootPid: number): Promise<void> {
  if (!Number.isFinite(rootPid) || rootPid <= 0) return;
  if (process.platform === 'win32') {
    await runCapture('taskkill', ['/PID', String(rootPid), '/T', '/F']);
    return;
  }
  const tree = await enumerateProcessTree(rootPid);
  for (const node of tree.reverse()) {
    try {
      process.kill(node.pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
}

/**
 * Polls until every process in `pids` is gone or `timeoutMs` elapses.
 * Returns the pids still alive (empty array = clean kill, the proof artifact).
 */
export async function waitForTreeDeath(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids;
  while (Date.now() < deadline) {
    const snapshot = await listAllProcesses();
    // A zombie/defunct process (POSIX state starting with 'Z') has already been
    // killed but not yet reaped by its parent; it is DEAD for cleanup purposes
    // and MUST NOT be counted as a survivor, or a killed-but-unreaped child on
    // POSIX CI would make treeAfterKill spuriously non-empty. Windows rows
    // carry an empty state, so startsWith('Z') is always false there and the
    // Windows liveness check is unchanged.
    const livePids = new Set(
      snapshot.filter(node => !node.state.startsWith('Z')).map(node => node.pid)
    );
    alive = pids.filter(pid => livePids.has(pid));
    if (alive.length === 0) return [];
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return alive;
}
