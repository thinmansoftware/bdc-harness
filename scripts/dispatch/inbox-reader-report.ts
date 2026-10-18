import { readFile } from 'fs/promises';
import { buildReportFromSurfaceLines } from '../../packages/server/src/dispatch/inbox-reader';

const index = process.argv.indexOf('--surface');
const path = index >= 0 ? process.argv[index + 1] : undefined;
if (!path) {
  console.error('usage: bun scripts/dispatch/inbox-reader-report.ts --surface <path>');
  process.exit(2);
}

const report = buildReportFromSurfaceLines((await readFile(path, 'utf8')).split(/\r?\n/));
console.log(JSON.stringify(report, null, 2));
