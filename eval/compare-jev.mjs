// Paired reader for the --filter jev benchmark: one row per case, the filtered arm
// against the unfiltered one, within the same model. Repeats aggregate per (case, arm)
// so a pass rate of 1/3 reads as instability rather than a flip. compare.mjs is left
// alone: it pairs the skill against naive grep and gates on the 50% cost target.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? path.join(import.meta.dirname, 'results', 'jev-filter.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = raw.results?.results ?? raw.results ?? [];
const BASE = 'session-grep';
const JEV = 'session-grep-jev';

const byCase = new Map();
for (const r of results) {
  const [arm, model = 'default'] = (r.provider?.label ?? r.provider?.id ?? 'unknown').split('|');
  const caseId = r.testCase?.vars?.id ?? r.vars?.id ?? 'unknown';
  const m = r.metadata ?? r.response?.metadata ?? {};
  const key = `${caseId}|${model}`;
  if (!byCase.has(key)) byCase.set(key, {});
  const arms = byCase.get(key);
  const a = (arms[arm] ??= { runs: 0, passes: 0, cost: 0, chars: 0, calls: 0 });
  a.runs++;
  a.passes += r.success ? 1 : 0;
  a.cost += r.cost ?? r.response?.cost ?? 0;
  a.chars += m.toolResultChars ?? 0;
  a.calls += Array.isArray(m.toolCalls) ? m.toolCalls.length : (m.toolCalls ?? 0);
}

const rows = [];
const tot = { b: { p: 0, r: 0, c: 0, ch: 0, ca: 0 }, j: { p: 0, r: 0, c: 0, ch: 0, ca: 0 } };
let unstable = 0;
for (const [key, arms] of byCase) {
  const b = arms[BASE], j = arms[JEV];
  if (!b || !j) continue;
  for (const [t, s] of [[tot.b, b], [tot.j, j]]) { t.p += s.passes; t.r += s.runs; t.c += s.cost; t.ch += s.chars; t.ca += s.calls; }
  const flaky = (s) => s.passes > 0 && s.passes < s.runs;
  if (flaky(b) || flaky(j)) unstable++;
  rows.push([key.split('|')[0], b, j, flaky(b) || flaky(j)]);
}
if (!rows.length) { console.log('No paired cases.'); process.exit(1); }

const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b - 1) * 100).toFixed(0)}%`);
console.log(`paired cases: ${rows.length}   repeats: ${rows[0][1].runs}`);
console.log(`pass rate:    base ${tot.b.p}/${tot.b.r}   jev ${tot.j.p}/${tot.j.r}`);
console.log(`cost:         base $${tot.b.c.toFixed(4)}   jev $${tot.j.c.toFixed(4)}   ${pct(tot.j.c, tot.b.c)}`);
console.log(`tool bytes:   base ${tot.b.ch}   jev ${tot.j.ch}   ${pct(tot.j.ch, tot.b.ch)}`);
console.log(`tool calls:   base ${tot.b.ca}   jev ${tot.j.ca}   ${pct(tot.j.ca, tot.b.ca)}`);
console.log(`cases where either arm was unstable across repeats: ${unstable}/${rows.length}`);
console.log('\ncase                          base  jev   base$    jev$     base chars  jev chars');
for (const [id, b, j, flaky] of rows.sort((x, y) => x[0].localeCompare(y[0]))) {
  const mark = flaky ? '~' : (b.passes === j.passes ? ' ' : (b.passes > j.passes ? 'v' : '^'));
  console.log(`${mark} ${id.padEnd(28)}${b.passes}/${b.runs}   ${j.passes}/${j.runs}   ${(b.cost / b.runs).toFixed(4)}  ${(j.cost / j.runs).toFixed(4)}  ${String(Math.round(b.chars / b.runs)).padStart(10)}  ${String(Math.round(j.chars / j.runs)).padStart(9)}`);
}
console.log('\n~ = unstable across repeats (not a flip)   ^ = jev better   v = base better');
