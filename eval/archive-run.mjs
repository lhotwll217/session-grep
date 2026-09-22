// Copy a finished run's results to a run-scoped path. promptfoo writes one fixed
// outputPath, so without this the previous run's detail is gone and a ledger entry
// that cites it points at whatever ran last.
import fs from 'node:fs';
import path from 'node:path';

const [src, runId] = process.argv.slice(2);
if (!src || !runId) { console.error('usage: node eval/archive-run.mjs <results.json> <runId>'); process.exit(2); }
const dest = path.join(path.dirname(src), 'iterations', `${runId}.json`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(dest);
