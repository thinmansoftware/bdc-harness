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
      }));
    } catch {
      return [];
    }
  }
  const { stdout } = await runCapture('ps', ['-eo', 'pid=,ppid=,comm=']);
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [pid, ppid, ...name] = line.split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), name: name.join(' ') };
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
    const livePids = new Set(snapshot.map(node => node.pid));
    alive = pids.filter(pid => livePids.has(pid));
    if (alive.length > 0 && process.platform !== 'win32') {
      // WO-HARNESS-ACP-KILL-EVIDENCE-FIX-01: a POSIX zombie (state 'Z...')
      // is killed-but-unreaped -- it can never run again; only its parent's
      // wait() is pending. Counting it as a survivor falsely fails the
      // cleanup proof, so drop zombies (and pids that vanished between the
      // snapshot and the state read). Windows has no zombie state; that
      // branch is unchanged.
      const states = await Promise.all(
        alive.map(async pid => {
          const { stdout } = await runCapture('ps', ['-o', 'stat=', '-p', String(pid)]);
          return { pid, stat: stdout.trim() };
        })
      );
      alive = states
        .filter(entry => entry.stat !== '' && !entry.stat.startsWith('Z'))
        .map(entry => entry.pid);
    }
    if (alive.length === 0) return [];
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return alive;
}
