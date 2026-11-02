import { appendFile, mkdir, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';

/**
 * Minimal size-based rotating file logger for the dispatch worker.
 *
 * Before this change the worker only wrote via console.error/console.log,
 * which the Windows Scheduled Task (hidden window, no redirection) discards
 * entirely -- there was no persistent diagnostic trail at all. This adds a
 * bounded, rotating log file so a crash or restart leaves evidence on disk
 * without the file growing without limit.
 *
 * Rotation is size-based (simpler and more predictable than time-based for a
 * low/irregular-volume worker log): when the active file exceeds
 * maxBytes, it is renamed to <file>.1, any previous <file>.1 is dropped, and a
 * fresh active file is started. maxFiles bounds total retained history.
 */

export interface WorkerLogOptions {
  file: string;
  maxBytes?: number;
  maxFiles?: number;
}

export interface WorkerLog {
  info: (message: string) => Promise<void>;
  error: (message: string, error?: unknown) => Promise<void>;
}

async function rotateIfNeeded(file: string, maxBytes: number, maxFiles: number): Promise<void> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return; // file does not exist yet; nothing to rotate
  }
  if (size < maxBytes) return;

  // Shift <file>.(N-1) -> <file>.N down to <file>.1, dropping anything at the
  // top of the range, then move the active file into <file>.1.
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = `${file}.${index}`;
    const to = `${file}.${index + 1}`;
    try {
      if (index + 1 > maxFiles) {
        await rm(from, { force: true });
      } else {
        await rename(from, to);
      }
    } catch {
      // Missing intermediate file is fine; rotation is best-effort.
    }
  }
  try {
    await rename(file, `${file}.1`);
  } catch {
    // If rename fails (e.g. file vanished mid-rotation), fall through and let
    // the next append create a fresh file.
  }
}

export function createWorkerLog(options: WorkerLogOptions): WorkerLog {
  const file = options.file;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024; // 5 MB per file
  const maxFiles = options.maxFiles ?? 5; // active + up to 5 rotated = 6 total

  let writeChain: Promise<void> = mkdir(dirname(file), { recursive: true }).then(() => undefined);

  function write(level: 'INFO' | 'ERROR', message: string): Promise<void> {
    writeChain = writeChain
      .then(() => rotateIfNeeded(file, maxBytes, maxFiles))
      .then(() => {
        const line = `${new Date().toISOString()} [${level}] ${message}\n`;
        return appendFile(file, line, 'utf8');
      })
      .catch(() => {
        // Logging must never crash the worker. Swallow and continue; the
        // worker's real job (polling/claiming/running messages) proceeds
        // regardless of disk/log health.
      });
    return writeChain;
  }

  return {
    info: (message: string): Promise<void> => write('INFO', message),
    error: (message: string, error?: unknown): Promise<void> => {
      const detail = formatErrorDetail(error);
      return write('ERROR', detail ? `${message}: ${detail}` : message);
    },
  };
}

function formatErrorDetail(error: unknown): string {
  if (error === undefined || error === null) return '';
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}
