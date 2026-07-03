#!/usr/bin/env node
// One auto-research iteration: run the eval, distill the results into a timestamped
// structured record, append it to the history, and diff against the previous
// iteration. Keeps every artifact small and machine-parseable:
//
//   eval/history.jsonl                    — one compact line per iteration (committed;
//                                           the trend — run math on this)
//   eval/findings.jsonl                   — one line per qualitative finding (committed)
//   eval/results/iterations/<ts>.json     — full per-case detail (gitignored, regenerable)
//   eval/results/logs/<ts>/               — raw trajectories (gitignored)
//
//   node eval/loop.mjs --label "iter1: compact json output"
//                      [--probe | --cases id1,id2 | --full]   (default: 8-case core)
//                      [--providers haiku|sonnet] [--repeat N] [--dry]
//                      [--notes "hypothesis and expected effect"]
//
// --probe = 3 distributed cases (fastest signal); --cases = exact targets for a
// case-specific fix; core = accept/reject; --full = holdout confirmation only.
// --dry skips the eval and just re-summarizes latest.json (after a manual run).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const resultsDir = path.join(here, 'results');
const iterDir = path.join(resultsDir, 'iterations');
fs.mkdirSync(iterDir, { recursive: true });

// The iteration ladder — cheapest signal first, fuller runs only to confirm:
//   --probe        3 cases (~4 min): quickest read on whether a change does anything
//   --cases a,b,c  arbitrary targets: iterate on the exact cases a change addresses
//   (default core) 8 cases: accept/reject decisions
//   --full         29 cases: holdout confirmation of accepted improvements only
const PROBE_IDS = [
  'roadmap-rule',            // needle/easy/sidebar-ced6 — cheap sanity signal
  'context-blowup',          // synthesis/hard/origin-269a — biggest session, hard paraphrase
  'sidebar-data-ownership',  // decision/hard/sidebar-ced6 — answer flips mid-thread
];

// Core subset: one fast cycle, still spread across qtype/difficulty/session.
// summarize-origin + prompting-critique were PROMOTED from holdout after iter2's
// holdout sample showed summary/meta qtypes are the cost sinks (findings.jsonl);
// holdout keeps summarize-sidebar/retrospective-sidebar as untouched confirmers.
const CORE_IDS = [
  'roadmap-rule',            // needle/easy/sidebar-ced6
  'interactive-launch',      // needle/easy/launch-fd0e
  'ripgrep-shim',            // synthesis/medium/rpc-8800
  'deep-links',              // synthesis/medium/origin-269a
  'context-blowup',          // synthesis/hard/origin-269a
  'superset-mixup',          // synthesis/hard/sidebar-ced6
  'sidebar-data-ownership',  // decision/hard/sidebar-ced6
  'keywords-slide-cut',      // synthesis/hard/deck-0b2b
  'summarize-origin',        // summary/hard/origin-269a (promoted 2026-07-01)
  'prompting-critique',      // meta/hard/origin-269a (promoted 2026-07-01)
];

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const label = opt('label', 'unlabeled');
const notes = opt('notes', null);
const providers = opt('providers', 'haiku');
// --suite codex: the extension suite (codex + cross-source cases) over the COMBINED
// fixture tree — a separate corpus era, never compared against main-suite records.
const suite = opt('suite', 'main');
const full = has('full');
const probe = has('probe');
const customCases = opt('cases', null); // --cases id1,id2 for targeted iteration
const repeat = opt('repeat', null); // k>1 for accept decisions on correctness-sensitive changes
// The codex extension suite is only 6 cases — its default scope is all of them.
const scope = customCases ? 'custom' : probe ? 'probe' : (full || suite === 'codex') ? 'full' : 'core';
const scopeIds = customCases ? customCases.split(',') : probe ? PROBE_IDS : CORE_IDS;
const pattern = opt('filter-pattern', scope === 'full' && !customCases ? null : `^(${scopeIds.join('|')})$`);
const dry = has('dry');

const ts = new Date().toISOString();
const runId = ts.replace(/[:.]/g, '-').slice(0, 19);

// Audit trail: hash the artifacts under test so every history record is traceable to
// the exact tool/prompt versions that produced it.
const md5 = (p) => {
  try { return createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch { return null; }
};
const md5Many = (paths, base = repoRoot) => {
  const h = createHash('md5');
  let found = false;
  for (const p of paths) {
    try {
      h.update(path.relative(base, p).split(path.sep).join('/'));
      h.update('\0');
      h.update(fs.readFileSync(p));
      h.update('\0');
      found = true;
    } catch {
      // Missing private artifacts, such as cases.yaml in a fresh clone, hash as null.
    }
  }
  return found ? h.digest('hex').slice(0, 12) : null;
};
const skillDir = path.join(repoRoot, 'skills', 'session-grep');
const adapterFiles = fs.readdirSync(path.join(skillDir, 'adapters'))
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .map((f) => path.join(skillDir, 'adapters', f));
const artifacts = {
  tool: md5Many([
    path.join(repoRoot, 'bin', 'session-grep.mjs'),
    path.join(skillDir, 'session-grep.mjs'),
    path.join(skillDir, 'sources.mjs'),
    ...adapterFiles,
  ]),
  skill: md5(path.join(skillDir, 'SKILL.md')),
  provider: md5(path.join(here, 'providers', 'claude-agent.mjs')),
  cases: md5(path.join(here, 'cases.yaml')),
  git: (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout ?? '').trim() || null,
};

if (!dry) {
  const configFile = suite === 'codex' ? 'promptfooconfig-codex.yaml' : 'promptfooconfig.yaml';
  const evalArgs = [
    'eval', '-c', path.join(here, configFile),
    '--no-cache', '-j', '3',
    ...(providers ? ['--filter-providers', providers] : []),
    ...(pattern ? ['--filter-pattern', pattern] : []),
    ...(repeat ? ['--repeat', repeat] : []),
  ];
  console.log(`[loop] ${ts} label="${label}" suite=${suite} providers=${providers} scope=${scope}${scope !== 'full' ? `(${scopeIds.length})` : ''} run=${runId}`);
  const run = spawnSync('promptfoo', evalArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      SESSION_GREP_RUN_ID: runId,
      // Extension suite searches the combined tree; main suite keeps its frozen corpus.
      ...(suite === 'codex' ? { SESSION_GREP_EVAL_FIXTURES: path.join(here, 'fixtures') } : {}),
    },
  });
  if (run.status !== 0) console.error(`[loop] promptfoo exited ${run.status} — summarizing whatever landed in latest.json`);
}

// ── distill latest.json ─────────────────────────────────────────────────────
const data = JSON.parse(fs.readFileSync(path.join(resultsDir, 'latest.json'), 'utf8'));
const results = data.results?.results ?? [];

const cases = results.map((r) => {
  const [arm, model = 'default'] = (r.provider?.label ?? 'unknown').split('|');
  const m = r.response?.metadata ?? {};
  const rubric = (r.gradingResult?.componentResults ?? []).find((c) => c.assertion?.type === 'llm-rubric');
  return {
    id: r.vars?.id ?? `test-${r.testIdx}`,
    arm,
    model,
    qtype: r.testCase?.metadata?.qtype ?? null,
    difficulty: r.testCase?.metadata?.difficulty ?? null,
    session: r.testCase?.metadata?.session ?? null,
    correct: rubric ? (rubric.pass ? 1 : 0) : null,
    rubricReason: (rubric?.reason ?? '').slice(0, 300),
    cost: round(m.costUsd ?? 0, 5),
    tokens: m.tokensTotal ?? 0,
    toolCalls: m.toolCallCount ?? 0,
    toolResultChars: m.toolResultChars ?? 0,
    turns: m.numTurns ?? 0,
    durationMs: m.durationMs ?? 0,
    error: r.error ?? null,
  };
});

const agg = {};
for (const c of cases) {
  const k = `${c.arm}|${c.model}`;
  agg[k] ??= { n: 0, correct: 0, graded: 0, cost: 0, tokens: 0, toolCalls: 0, toolResultChars: 0 };
  const a = agg[k];
  a.n++;
  if (c.correct !== null) { a.graded++; a.correct += c.correct; }
  a.cost = round(a.cost + c.cost, 5);
  a.tokens += c.tokens;
  a.toolCalls += c.toolCalls;
  a.toolResultChars += c.toolResultChars;
}
for (const a of Object.values(agg)) a.acc = a.graded ? round(a.correct / a.graded, 3) : null;

// Gate per model (paired: only cases present in both arms). Repeats (--repeat N)
// aggregate per case — mean cost, mean correctness — instead of clobbering
// (codex review P0: Map-by-id silently kept one result per case).
const gates = {};
for (const model of [...new Set(cases.map((c) => c.model))]) {
  const byArm = { 'session-grep': new Map(), 'naive-grep': new Map() };
  for (const c of cases) {
    if (c.model !== model || !byArm[c.arm]) continue;
    if (!byArm[c.arm].has(c.id)) byArm[c.arm].set(c.id, []);
    byArm[c.arm].get(c.id).push(c);
  }
  const mean = (rs, k) => rs.reduce((t, r) => t + (r[k] ?? 0), 0) / rs.length;
  const agg1 = (rs) => ({ cost: mean(rs, 'cost'), correct: mean(rs, 'correct'), n: rs.length });
  const sg = new Map([...byArm['session-grep']].map(([id, rs]) => [id, agg1(rs)]));
  const nv = new Map([...byArm['naive-grep']].map(([id, rs]) => [id, agg1(rs)]));
  const ids = [...sg.keys()].filter((id) => nv.has(id));
  if (!ids.length) continue;
  const sum = (map, k) => ids.reduce((t, id) => t + (map.get(id)[k] ?? 0), 0);
  const costRatio = sum(nv, 'cost') > 0 ? round(sum(sg, 'cost') / sum(nv, 'cost'), 3) : null;
  const accSg = round(sum(sg, 'correct') / ids.length, 3);
  const accNv = round(sum(nv, 'correct') / ids.length, 3);
  // Paired per-case stats — noise-robust vs aggregate means (one runaway trajectory
  // wrecks a mean; medians and win counts don't move).
  const perCaseRatios = ids
    .filter((id) => nv.get(id).cost > 0)
    .map((id) => sg.get(id).cost / nv.get(id).cost)
    .sort((a, b) => a - b);
  const medianCostRatio = perCaseRatios.length ? round(perCaseRatios[Math.floor(perCaseRatios.length / 2)], 3) : null;
  const cheaperWins = ids.filter((id) => sg.get(id).cost < nv.get(id).cost).length;
  const repeats = Math.max(...ids.map((id) => sg.get(id).n), ...ids.map((id) => nv.get(id).n));
  gates[model] = {
    paired: ids.length,
    repeats,
    costRatio,
    medianCostRatio,
    accSg,
    accNv,
    cheaperWins: `${cheaperWins}/${ids.length}`,
    pass: costRatio !== null && costRatio <= 0.5 && accSg >= accNv,
  };
}

const logsDir = dry
  ? latestLogsDir()
  : path.relative(repoRoot, path.join(resultsDir, 'logs', runId));
const record = {
  ts, runId, label, notes, providers,
  suite, scope, pattern,
  artifacts, logs: logsDir,
  detail: `eval/results/iterations/${runId}.json`,
  gates, agg,
};
fs.writeFileSync(path.join(iterDir, `${runId}.json`), JSON.stringify({ ...record, cases }, null, 2));
fs.appendFileSync(path.join(here, 'history.jsonl'), JSON.stringify(record) + '\n');

// ── report + diff vs previous comparable iteration ──────────────────────────
console.log(`\n[loop] ${label} — ${ts}`);
console.table(Object.entries(agg).map(([k, a]) => ({ arm: k, ...a })));
for (const [model, g] of Object.entries(gates)) {
  console.log(`gate(${model}): costRatio=${g.costRatio} (target<=0.5) accSg=${g.accSg} accNv=${g.accNv} cheaperWins=${g.cheaperWins} → ${g.pass ? 'PASS' : 'FAIL'}`);
}

const history = fs.readFileSync(path.join(here, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const prev = history.filter((h) => h.scope === record.scope && h.providers === record.providers && (h.suite ?? 'main') === suite).slice(-2, -1)[0];
if (prev) {
  console.log(`\n[loop] vs previous (${prev.label} @ ${prev.ts}):`);
  for (const [model, g] of Object.entries(gates)) {
    const p = prev.gates?.[model];
    if (!p) continue;
    console.log(`  ${model}: costRatio ${p.costRatio} → ${g.costRatio}   accSg ${p.accSg} → ${g.accSg}   accNv ${p.accNv} → ${g.accNv}`);
  }
} else {
  console.log('\n[loop] no previous comparable iteration — this is the baseline for its scope.');
}

function round(x, d) {
  return Math.round(x * 10 ** d) / 10 ** d;
}

// For --dry (summarizing a run promptfoo made without us): the newest logs dir.
function latestLogsDir() {
  const base = path.join(resultsDir, 'logs');
  try {
    const newest = fs.readdirSync(base)
      .map((n) => ({ n, t: fs.statSync(path.join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    return newest ? path.relative(repoRoot, path.join(base, newest.n)) : null;
  } catch {
    return null;
  }
}
