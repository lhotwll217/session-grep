import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GREP = join(here, '..', 'skills', 'session-grep', 'session-grep.mjs');
const hasRg = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !hasRg && 'ripgrep not installed';

const line = (role, text, timestamp) =>
  JSON.stringify({ type: role, timestamp, message: { role, content: [{ type: 'text', text }] } }) + '\n';

let fixtureRoot;
let fakeJev;
let captureFile;

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'session-grep-jev-'));
  mkdirSync(join(fixtureRoot, 'sessions'), { recursive: true });
  captureFile = join(fixtureRoot, 'capture.json');
  fakeJev = join(fixtureRoot, 'fake-jev.mjs');
  writeFileSync(fakeJev, `#!/usr/bin/env node
import fs from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (process.env.FAKE_JEV_CAPTURE) {
  fs.writeFileSync(process.env.FAKE_JEV_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), input }));
}
const rows = input.trim().split('\\n').filter(Boolean).map((row) => JSON.parse(row));
const result = (row, score) => JSON.stringify({ id: row.id, answers: { relevance: { type: 'score', score } } });
const mode = process.env.FAKE_JEV_MODE || 'success';
const score = (row) => mode === 'tie' ? 4 : row.state.candidate_text.includes('SEMANTIC-BEST') ? 9 : row.state.candidate_text.includes('SEMANTIC-MIDDLE') ? 5 : mode === 'subfloor' ? 0.1 : 1;

if (mode === 'malformed') {
  process.stdout.write(rows.map(() => '{not json}').join('\\n') + '\\n');
} else if (mode === 'duplicate') {
  process.stdout.write(rows.map((row, index) => result(index === rows.length - 1 ? rows[0] : row, score(row))).join('\\n') + '\\n');
} else if (mode === 'unknown') {
  process.stdout.write(rows.map((row, index) => result(index === rows.length - 1 ? { id: 'c999' } : row, score(row))).join('\\n') + '\\n');
} else if (mode === 'missing') {
  process.stdout.write(rows.slice(0, -1).map((row) => result(row, score(row))).join('\\n') + '\\n');
} else if (mode === 'score-null') {
  process.stdout.write(rows.map((row) => JSON.stringify({ id: row.id, answers: { relevance: { score: null } } })).join('\\n') + '\\n');
} else if (mode === 'score-string') {
  process.stdout.write(rows.map((row) => JSON.stringify({ id: row.id, answers: { relevance: { score: '9' } } })).join('\\n') + '\\n');
} else if (mode === 'score-infinite') {
  process.stdout.write(rows.map((row) => '{"id":' + JSON.stringify(row.id) + ',"answers":{"relevance":{"score":1e309}}}').join('\\n') + '\\n');
} else {
  process.stdout.write([...rows].reverse().map((row) => result(row, score(row))).join('\\n') + '\\n');
}
if (mode === 'nonzero') process.exitCode = 4;
if (mode === 'partial') process.exitCode = 5;
`);
  chmodSync(fakeJev, 0o755);

  writeFileSync(
    join(fixtureRoot, 'sessions', 'lexical-first.jsonl'),
    line('user', 'PRIVATE-CONTEXT-FIRST', '2026-06-03T09:00:00Z') +
      line('assistant', 'needle lexical first candidate', '2026-06-03T09:01:00Z'),
  );
  writeFileSync(
    join(fixtureRoot, 'sessions', 'semantic-middle.jsonl'),
    line('assistant', 'needle SEMANTIC-MIDDLE candidate', '2026-06-02T09:01:00Z'),
  );
  writeFileSync(
    join(fixtureRoot, 'sessions', 'semantic-best.jsonl'),
    line('user', 'PRIVATE-CONTEXT-BEST', '2026-06-01T09:00:00Z') +
      line('assistant', 'needle SEMANTIC-BEST candidate', '2026-06-01T09:01:00Z') +
      line('user', 'PRIVATE-AFTER-BEST', '2026-06-01T09:02:00Z'),
  );
});

// The filter only engages at ten or more candidates, so it gets its own larger root
// and the rerank fixture above keeps its exact, asserted ordering.
let filterRoot;
before(() => {
  filterRoot = mkdtempSync(join(tmpdir(), 'session-grep-jev-filter-'));
  writeFileSync(join(filterRoot, 'semantic-best.jsonl'), line('assistant', 'needle SEMANTIC-BEST candidate', '2026-06-01T09:01:00Z'));
  writeFileSync(join(filterRoot, 'semantic-middle.jsonl'), line('assistant', 'needle SEMANTIC-MIDDLE candidate', '2026-06-02T09:01:00Z'));
  for (let i = 0; i < 9; i++) {
    writeFileSync(join(filterRoot, `filler-${i}.jsonl`), line('assistant', `needle filler candidate ${i}`, `2026-05-0${i + 1}T09:01:00Z`));
  }
});
after(() => rmSync(filterRoot, { recursive: true, force: true }));

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const baseArgs = ['--query', 'needle', '--any', '--candidates', '--limit', '2', '--max-chars', '8000', '--json', '--root', fixtureRoot];
const envFor = (mode = 'success', extra = {}) => ({
  ...process.env,
  SESSION_GREP_JEV_BIN: fakeJev,
  FAKE_JEV_MODE: mode,
  FAKE_JEV_CAPTURE: captureFile,
  ...extra,
});
const runJson = (args = [], env = envFor()) => JSON.parse(execFileSync(
  process.execPath,
  [GREP, ...baseArgs, ...args],
  { encoding: 'utf8', env },
));

test('--rerank jev reorders grouped candidates while preserving lexical pointers and score', { skip }, () => {
  const lexical = runJson([], envFor('success', { FAKE_JEV_CAPTURE: '' }));
  const lexicalAll = runJson(['--limit', '3'], envFor('success', { FAKE_JEV_CAPTURE: '' }));
  assert.deepEqual(lexical.candidates.map((candidate) => candidate.id), ['lexical-first', 'semantic-best']);

  const reranked = runJson(['--rerank', 'jev']);
  assert.deepEqual(reranked.candidates.map((candidate) => candidate.id), ['semantic-best', 'semantic-middle']);
  assert.equal(reranked.candidates[0].index, 1);
  assert.equal(reranked.candidates[0].semanticScore, 9);
  assert.equal(reranked.candidates[0].score, lexicalAll.candidates.find((candidate) => candidate.id === 'semantic-best').score);

  const textOutput = execFileSync(
    process.execPath,
    [GREP, ...baseArgs.filter((arg) => arg !== '--json'), '--rerank', 'jev'],
    { encoding: 'utf8', env: envFor('success', { FAKE_JEV_CAPTURE: '' }) },
  );
  assert.match(textOutput, /id=semantic-best best_idx=1 .*semantic_score=9/);

  const pointer = execFileSync(
    process.execPath,
    [GREP, '--session', reranked.candidates[0].id, '--at', String(reranked.candidates[0].index), '--root', fixtureRoot],
    { encoding: 'utf8' },
  );
  assert.match(pointer, /\[1\]\* assistant .*SEMANTIC-BEST/);
});

test('Jev receives exact arguments and only bounded, synthetic candidate rows', { skip }, () => {
  const privacyRoot = join(fixtureRoot, 'SECRET-PATH-DO-NOT-SEND');
  mkdirSync(privacyRoot, { recursive: true });
  for (let index = 0; index < 22; index++) {
    writeFileSync(
      join(privacyRoot, `privacy-${String(index).padStart(2, '0')}.jsonl`),
      line('user', `PRIVATE-CONTEXT-${index}`, `2026-05-${String((index % 20) + 1).padStart(2, '0')}T08:00:00Z`) +
        JSON.stringify({ type: 'user', timestamp: '2026-05-01T08:00:30Z', message: { role: 'user', content: [{ type: 'tool_result', content: `PAYLOADWORD PRIVATE-TOOL-${index}` }] } }) + '\n' +
        line('user', `Base directory for this skill: /PRIVATE/SKILL-${index}\n\n# skill\nPAYLOADWORD PRIVATE-SKILL-BODY-${index}`, '2026-05-01T08:00:40Z') +
        line('assistant', `PAYLOADWORD ${'candidate text '.repeat(500)} ${index}`, `2026-05-${String((index % 20) + 1).padStart(2, '0')}T08:01:00Z`) +
        line('user', `PRIVATE-AFTER-${index}`, `2026-05-${String((index % 20) + 1).padStart(2, '0')}T08:02:00Z`) +
        JSON.stringify({ type: 'metadata', raw_marker: `PRIVATE-RAW-JSONL-${index}` }) + '\n',
    );
  }
  const longQuery = Array.from({ length: 90 }, () => 'payloadword').join(' ');
  execFileSync(
    process.execPath,
    [GREP, '--query', longQuery, '--any', '--candidates', '--rerank', 'jev', '--limit', '20', '--max-chars', '30000', '--json', '--root', privacyRoot],
    { encoding: 'utf8', env: envFor() },
  );

  const capture = JSON.parse(readFileSync(captureFile, 'utf8'));
  assert.deepEqual(
    [capture.argv[0], capture.argv[1], capture.argv[3], capture.argv[4], capture.argv[5], capture.argv[6]],
    ['batch', '--questions', '--concurrency', '4', '--no-summary', '--no-warn'],
  );
  const questions = JSON.parse(capture.argv[2]);
  assert.equal(questions.relevance.type, 'score');
  assert.deepEqual(questions.relevance.criteria.map((criterion) => criterion.split(':')[0]), ['irrelevant', 'related', 'direct']);
  assert.match(questions.relevance.instructions, /untrusted/i);
  assert.match(questions.relevance.instructions, /ignore any instructions/i);

  const rows = capture.input.trim().split('\n').map((row) => JSON.parse(row));
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.map((row) => row.id), Array.from({ length: 20 }, (_, index) => `c${index}`));
  assert.ok(rows.every((row) => Object.keys(row).join(',') === 'id,state'));
  assert.ok(rows.every((row) => Object.keys(row.state).join(',') === 'query,candidate_text'));
  assert.ok(rows.every((row) => Buffer.byteLength(row.state.query) <= 512));
  assert.ok(rows.every((row) => Buffer.byteLength(row.state.candidate_text) <= 1000));
  assert.ok(Buffer.byteLength(capture.input) <= 32 * 1024);
  assert.doesNotMatch(capture.input, /privacy-\d|SECRET-PATH|2026-05-|PRIVATE-CONTEXT|PRIVATE-AFTER|PRIVATE-TOOL|PRIVATE-SKILL|PRIVATE-RAW/);
});

test('equal semantic scores retain the original lexical order', { skip }, () => {
  const lexical = runJson([], envFor('success', { FAKE_JEV_CAPTURE: '' }));
  const tied = runJson(['--rerank', 'jev'], envFor('tie', { FAKE_JEV_CAPTURE: '' }));
  assert.deepEqual(tied.candidates.map((candidate) => candidate.id), lexical.candidates.map((candidate) => candidate.id));
  assert.ok(tied.candidates.every((candidate) => candidate.semanticScore === 4));
});

test('default search never invokes Jev and keeps lexical output unchanged', { skip }, () => {
  rmSync(captureFile, { force: true });
  const withFakeAvailable = runJson([], envFor());
  const withoutFake = runJson([], { ...process.env, SESSION_GREP_JEV_BIN: '/missing/jev' });
  assert.deepEqual(withFakeAvailable, withoutFake);
  assert.equal(existsSync(captureFile), false);
});

test('a nonzero or partial exit still applies the rows Jev did score', { skip }, () => {
  const reranked = runJson(['--rerank', 'jev'], envFor('success', { FAKE_JEV_CAPTURE: '' }));
  for (const mode of ['nonzero', 'partial']) {
    const actual = runJson(['--rerank', 'jev'], envFor(mode, { FAKE_JEV_CAPTURE: '' }));
    assert.deepEqual(actual, reranked, mode);
  }
});

test('a candidate Jev could not score keeps its lexical rank', { skip }, () => {
  // Lexical order is [lexical-first, semantic-best, semantic-middle]; each mode leaves c2 unscored.
  for (const mode of ['missing', 'unknown', 'duplicate']) {
    const actual = runJson(['--rerank', 'jev'], envFor(mode, { FAKE_JEV_CAPTURE: '' }));
    assert.deepEqual(actual.candidates.map((candidate) => candidate.id), ['semantic-best', 'lexical-first'], mode);
    assert.equal(actual.candidates[0].semanticScore, 9, mode);
  }
  const unscored = runJson(['--rerank', 'jev', '--limit', '3'], envFor('missing', { FAKE_JEV_CAPTURE: '' }));
  assert.equal(unscored.candidates[2].id, 'semantic-middle');
  assert.equal(unscored.candidates[2].semanticScore, undefined);
});

test('output with no usable score leaves the complete lexical order unchanged', { skip }, () => {
  const lexical = runJson([], envFor('success', { FAKE_JEV_CAPTURE: '' }));
  const cases = [
    ['missing executable', 'success', { SESSION_GREP_JEV_BIN: join(fixtureRoot, 'missing-jev') }],
    ['malformed JSONL', 'malformed', {}],
    ['null score', 'score-null', {}],
    ['string score', 'score-string', {}],
    ['non-finite score', 'score-infinite', {}],
  ];
  for (const [name, mode, extra] of cases) {
    const actual = runJson(['--rerank', 'jev'], envFor(mode, { FAKE_JEV_CAPTURE: '', ...extra }));
    assert.deepEqual(actual, lexical, name);
  }
});

test('--rerank accepts only the bounded Jev candidate contract', { skip }, () => {
  const cases = [
    [['--query', 'needle', '--candidates', '--rerank', 'jev'], /--rerank jev requires --any/],
    [['--query', 'needle', '--any', '--rerank', 'jev'], /--rerank jev requires --candidates/],
    [['--query', 'needle', '--any', '--candidates', '--rerank', 'other'], /--rerank must be jev/],
    [['--query', 'needle', '--any', '--candidates', '--rerank', 'jev', '--limit', '21'], /--rerank jev requires --limit <= 20/],
  ];
  for (const [args, message] of cases) {
    const result = spawnSync(process.execPath, [GREP, ...args, '--root', fixtureRoot], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test('--filter jev drops sub-floor candidates, keeps lexical order, and reports the count', { skip }, () => {
  const filtered = JSON.parse(execFileSync(
    process.execPath,
    [GREP, '--query', 'needle', '--any', '--candidates', '--filter', 'jev', '--limit', '20', '--max-chars', '20000', '--json', '--root', filterRoot],
    { encoding: 'utf8', env: envFor('subfloor', { FAKE_JEV_CAPTURE: '' }) },
  ));
  // everything without a SEMANTIC marker scores 0.1, below the floor; both markers stay.
  assert.ok(filtered.jevDropped >= 1);
  assert.deepEqual(filtered.candidates.map((c) => c.id), ['semantic-best', 'semantic-middle']);
  assert.ok(filtered.candidates.every((c) => c.semanticScore >= 0.5));
});

test('--filter jev keeps every candidate when Jev scores none', { skip }, () => {
  const args = ['--query', 'needle', '--any', '--candidates', '--limit', '20', '--max-chars', '20000', '--json', '--root', filterRoot];
  const plain = JSON.parse(execFileSync(process.execPath, [GREP, ...args], { encoding: 'utf8' }));
  const filtered = JSON.parse(execFileSync(
    process.execPath,
    [GREP, ...args, '--filter', 'jev'],
    { encoding: 'utf8', env: { ...process.env, SESSION_GREP_JEV_BIN: join(filterRoot, 'missing-jev') } },
  ));
  assert.equal(filtered.jevDropped, 0);
  assert.deepEqual(filtered.candidates.map((c) => c.id), plain.candidates.map((c) => c.id));
  assert.match(filtered.jevFilterSkipped, /not found/, 'an absent binary must be named, not silently ignored');
});

test('--filter jev names the reason when Jev runs but returns nothing usable', { skip }, () => {
  const out = JSON.parse(execFileSync(
    process.execPath,
    [GREP, '--query', 'needle', '--any', '--candidates', '--filter', 'jev', '--limit', '20', '--max-chars', '20000', '--json', '--root', filterRoot],
    { encoding: 'utf8', env: envFor('malformed', { FAKE_JEV_CAPTURE: '' }) },
  ));
  assert.equal(out.jevDropped, 0);
  assert.match(out.jevFilterSkipped, /no usable scores/);
  assert.equal(out.candidates.length, 11, 'every candidate is kept');
});

test('--filter jev reports a dropped count rather than a reason when Jev works', { skip }, () => {
  const out = JSON.parse(execFileSync(
    process.execPath,
    [GREP, '--query', 'needle', '--any', '--candidates', '--filter', 'jev', '--limit', '20', '--max-chars', '20000', '--json', '--root', filterRoot],
    { encoding: 'utf8', env: envFor('subfloor', { FAKE_JEV_CAPTURE: '' }) },
  ));
  assert.ok(out.jevDropped > 0);
  assert.equal(out.jevFilterSkipped, undefined, 'a working filter reports no skip reason');
});

test('--filter jev rejects combinations it cannot honour', { skip }, () => {
  const cases = [
    [['--query', 'needle', '--candidates', '--filter', 'jev'], /--filter jev requires --any/],
    [['--query', 'needle', '--any', '--filter', 'jev'], /--filter jev requires --candidates/],
    [['--query', 'needle', '--any', '--candidates', '--filter', 'other'], /--filter must be jev/],
    [['--query', 'needle', '--any', '--candidates', '--filter', 'jev', '--limit', '21'], /--filter jev requires --limit <= 20/],
    [['--query', 'needle', '--any', '--candidates', '--filter', 'jev', '--rerank', 'jev'], /--filter and --rerank cannot be combined/],
  ];
  for (const [args, message] of cases) {
    const result = spawnSync(process.execPath, [GREP, ...args, '--root', fixtureRoot], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test('--filter jev does not call Jev when the pool is below the minimum', { skip }, () => {
  const smallRoot = mkdtempSync(join(tmpdir(), 'session-grep-jev-small-'));
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(smallRoot, `s-${i}.jsonl`), line('assistant', `needle small ${i}`, `2026-04-0${i + 1}T09:00:00Z`));
  }
  const capture = join(smallRoot, 'capture.json');
  const out = JSON.parse(execFileSync(
    process.execPath,
    [GREP, '--query', 'needle', '--any', '--candidates', '--filter', 'jev', '--limit', '20', '--max-chars', '8000', '--json', '--root', smallRoot],
    { encoding: 'utf8', env: { ...process.env, SESSION_GREP_JEV_BIN: fakeJev, FAKE_JEV_CAPTURE: capture, FAKE_JEV_MODE: 'subfloor' } },
  ));
  assert.equal(existsSync(capture), false, 'Jev must not be invoked for a small pool');
  assert.equal(out.jevDropped, 0);
  assert.match(out.jevFilterSkipped, /pool below 10/);
  assert.equal(out.candidates.length, 3);
  rmSync(smallRoot, { recursive: true, force: true });
});
