#!/usr/bin/env node
// The efficiency gate + benchmark report. Reads a promptfoo results JSON, pairs each
// test case across arms WITHIN each subject model, and checks the project target —
//
//   session-grep cost <= 50% of naive-grep cost, at correctness >= the naive arm.
//
//   node eval/compare.mjs [results.json] [--gate]
//
// Default path: eval/results/latest.json. With --gate, exits non-zero when any model
// misses the target (CI / auto-research loop). Cost (USD) is the primary metric — it
// is what the whole trajectory actually costs, cache-discounted; token and
// tool-result-chars ratios are reported for diagnosis. Also breaks correctness/cost
// down by qtype, difficulty, and session so regressions show WHERE they happen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const gate = args.includes('--gate');
const file = args.find((a) => !a.startsWith('--')) ?? path.join(here, 'results', 'latest.json');

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = data.results?.results ?? data.results ?? [];
if (!results.length) {
  console.error(`No results found in ${file}`);
  process.exit(1);
}

const SKILL = 'session-grep';
const NAIVE = 'naive-grep';

// One record per (case, model, arm).
const records = [];
for (const r of results) {
  const label = r.provider?.label ?? r.provider?.id ?? 'unknown';
  const [arm, model = 'default'] = label.split('|');
  const m = r.response?.metadata ?? {};
  const rubric = (r.gradingResult?.componentResults ?? []).find((c) => c.assertion?.type === 'llm-rubric');
  records.push({
    caseId: r.vars?.id ?? `test-${r.testIdx}`,
    arm,
    model,
    qtype: r.testCase?.metadata?.qtype ?? 'unknown',
    difficulty: r.testCase?.metadata?.difficulty ?? 'unknown',
    session: r.testCase?.metadata?.session ?? 'unknown',
    correct: rubric ? (rubric.pass ? 1 : 0) : null,
    cost: m.costUsd ?? r.cost ?? 0,
    tokens: m.tokensTotal ?? r.tokenUsage?.total ?? 0,
    toolResultChars: m.toolResultChars ?? 0,
    toolCalls: m.toolCallCount ?? 0,
    turns: m.numTurns ?? 0,
    error: r.error ?? null,
  });
}

const models = [...new Set(records.map((r) => r.model))];
let allPass = true;

for (const model of models) {
  const recs = records.filter((r) => r.model === model);
  // Repeats aggregate per (case, arm) — mean cost/correctness — never clobber.
  const byCase = new Map();
  for (const r of recs) {
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, {});
    const arms = byCase.get(r.caseId);
    if (!arms[r.arm]) {
      arms[r.arm] = { ...r, n: 1 };
    } else {
      const a = arms[r.arm];
      a.n++;
      for (const k of ['cost', 'tokens', 'toolResultChars', 'toolCalls', 'turns']) a[k] += r[k];
      a.correct = (a.correct ?? 0) + (r.correct ?? 0);
    }
  }
  for (const arms of byCase.values()) {
    for (const a of Object.values(arms)) {
      for (const k of ['cost', 'tokens', 'toolResultChars', 'toolCalls', 'turns']) a[k] /= a.n;
      a.correct = a.correct === null ? null : a.correct / a.n;
    }
  }

  const rows = [];
  const sums = { [SKILL]: zero(), [NAIVE]: zero() };
  for (const [caseId, arms] of byCase) {
    const s = arms[SKILL];
    const n = arms[NAIVE];
    if (!s || !n) continue;
    add(sums[SKILL], s);
    add(sums[NAIVE], n);
    rows.push({
      case: caseId,
      'ok(sg)': mark(s.correct),
      'ok(nv)': mark(n.correct),
      'cost(sg)': s.cost.toFixed(3),
      'cost(nv)': n.cost.toFixed(3),
      ratio: n.cost > 0 ? (s.cost / n.cost).toFixed(2) : '-',
      'calls(sg)': s.toolCalls,
      'calls(nv)': n.toolCalls,
    });
  }
  if (!rows.length) continue;

  console.log(`\n═══ model: ${model} — ${rows.length} paired cases ═══`);
  console.table(rows);

  const sk = sums[SKILL];
  const nv = sums[NAIVE];
  const costRatio = nv.cost > 0 ? sk.cost / nv.cost : Infinity;
  const skAcc = sk.n ? sk.correct / sk.n : 0;
  const nvAcc = nv.n ? nv.correct / nv.n : 0;
  console.log(`correctness  session-grep ${(skAcc * 100).toFixed(0)}%  vs  naive ${(nvAcc * 100).toFixed(0)}%`);
  console.log(`cost         $${sk.cost.toFixed(3)} vs $${nv.cost.toFixed(3)}  ratio=${costRatio.toFixed(2)}  (target <= 0.50)`);
  console.log(`tokens       ${sk.tokens} vs ${nv.tokens}  ratio=${ratio(sk.tokens, nv.tokens)}`);
  console.log(`tool-result  ${sk.chars} vs ${nv.chars} chars  ratio=${ratio(sk.chars, nv.chars)}`);

  const pass = costRatio <= 0.5 && skAcc >= nvAcc;
  console.log(`GATE(${model}): ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) allPass = false;

  for (const dim of ['qtype', 'difficulty', 'session']) {
    const groups = [...new Set(recs.map((r) => r[dim]))].sort();
    const breakdown = groups.map((g) => {
      const sg = recs.filter((r) => r[dim] === g && r.arm === SKILL);
      const nvg = recs.filter((r) => r[dim] === g && r.arm === NAIVE);
      return {
        [dim]: g,
        n: sg.length,
        'acc(sg)': pct(sg),
        'acc(nv)': pct(nvg),
        'cost(sg)': sum(sg, 'cost').toFixed(3),
        'cost(nv)': sum(nvg, 'cost').toFixed(3),
      };
    });
    console.log(`\n— by ${dim} (${model}) —`);
    console.table(breakdown);
  }
}

console.log(`\nOVERALL GATE: ${allPass ? 'PASS' : 'FAIL'} — need cost ratio <= 0.50 at correctness >= control, per model`);
if (gate && !allPass) process.exit(2);

function zero() {
  return { cost: 0, tokens: 0, chars: 0, correct: 0, n: 0 };
}
function add(acc, r) {
  acc.cost += r.cost;
  acc.tokens += r.tokens;
  acc.chars += r.toolResultChars;
  acc.correct += r.correct ?? 0;
  acc.n++;
}
function mark(c) {
  return c === null ? '?' : c ? 'Y' : 'N';
}
function ratio(a, b) {
  return b > 0 ? (a / b).toFixed(2) : '-';
}
function sum(rs, k) {
  return rs.reduce((t, r) => t + r[k], 0);
}
function pct(rs) {
  const graded = rs.filter((r) => r.correct !== null);
  return graded.length ? `${((graded.reduce((t, r) => t + r.correct, 0) / graded.length) * 100).toFixed(0)}%` : '-';
}
