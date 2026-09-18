// Regression tests for #18 (fork-copy suppression). Fork/resume descendants replay
// the ancestor's prefix, so they share message 0. Two unrelated sessions that merely
// repeat one common line do not, and must stay separate results — collapsing them
// erased a whole session from --candidates, which is the mode's entire contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GREP = join(here, '..', 'skills', 'session-grep', 'session-grep.mjs');
const hasRg = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !hasRg && 'ripgrep not installed';

const claudeLine = (role, body, ts) =>
  JSON.stringify({ type: role, timestamp: ts, message: { role, content: [{ type: 'text', text: body }] } }) + '\n';

const SHARED = 'FORKNEEDLE confirmed the form-fill event and the tool-result loop.';
const ACK = 'ACKWORD sounds good, proceeding.';

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'session-grep-forks-'));
  mkdirSync(join(root, 'proj'), { recursive: true });
  const w = (name, body) => writeFileSync(join(root, 'proj', name), body);
  // A resume-of-a-resume family: same opening prompt, same replayed message.
  const family = (ts) => claudeLine('user', 'Start the terminal form-fill investigation', ts) + claudeLine('assistant', SHARED, ts);
  w('anc.jsonl', family('2026-04-06T21:26:18Z'));
  w('res1.jsonl', family('2026-04-10T17:29:13Z'));
  w('res2.jsonl', family('2026-04-10T17:29:19Z'));
  // Two unrelated projects that happen to share one boilerplate acknowledgement.
  w('alpha.jsonl',
    claudeLine('user', 'Set up the alpha deployment pipeline', '2026-05-02T10:00:00Z') +
    claudeLine('assistant', ACK, '2026-05-02T10:01:00Z'));
  w('beta.jsonl',
    claudeLine('user', 'Debug the beta parser crash', '2026-05-03T10:00:00Z') +
    claudeLine('assistant', ACK, '2026-05-03T10:01:00Z'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const run = (args) => execFileSync(process.execPath, [GREP, ...args, '--root', root], { encoding: 'utf8' });
const runJson = (args) => JSON.parse(run([...args, '--json']));

test('fork family collapses onto the earliest copy with a suppressed count', { skip }, () => {
  const out = runJson(['--query', 'FORKNEEDLE', '--max-chars', '4000']);
  assert.equal(out.totalMatches, 3);
  assert.equal(out.shown, 1);
  assert.equal(out.matches[0].id, 'anc');
  assert.equal(out.matches[0].forkCopies, 2);
  assert.match(run(['--query', 'FORKNEEDLE', '--max-chars', '4000']), /\+2 forked copies/);
});

test('unrelated sessions sharing one line stay separate hits', { skip }, () => {
  const out = runJson(['--query', 'ACKWORD', '--max-chars', '4000']);
  assert.equal(out.totalMatches, 2);
  assert.equal(out.shown, 2);
  assert.deepEqual(out.matches.map((m) => m.id).sort(), ['alpha', 'beta']);
  assert.ok(out.matches.every((m) => m.forkCopies === undefined));
});

test('--candidates keeps every matching session when text repeats across them', { skip }, () => {
  const out = runJson(['--query', 'ACKWORD', '--candidates', '--max-chars', '4000']);
  assert.equal(out.totalCandidateSessions, 2);
  assert.deepEqual(out.candidates.map((c) => c.id).sort(), ['alpha', 'beta']);
});

// #25/#26 seam: --candidates carries the session's union of matched words, which can
// include words absent from the BEST message. The preview must centre on one present.
test('candidate preview centres on a word the BEST message actually contains', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-grep-needle-'));
  mkdirSync(join(dir, 'proj'), { recursive: true });
  // The winning hit is the short COMMONW-dense message; RAREZZZ lives only in a long
  // sibling, so the session's union carries a word the BEST text does not contain.
  writeFileSync(join(dir, 'proj', 'g.jsonl'),
    claudeLine('assistant', `${'lead pad. '.repeat(240)}COMMONW COMMONW COMMONW decisive line.${' tail pad.'.repeat(240)}`, '2026-05-01T10:00:00Z') +
    claudeLine('assistant', `${'bulk filler. '.repeat(400)} RAREZZZ buried ${'more filler. '.repeat(400)}`, '2026-05-01T10:05:00Z'));
  try {
    const out = JSON.parse(execFileSync(process.execPath,
      [GREP, '--query', 'COMMONW RAREZZZ', '--any', '--candidates', '--json', '--max-chars', '1600', '--root', dir],
      { encoding: 'utf8' }));
    const best = out.candidates[0];
    assert.deepEqual(best.matchedWords.slice().sort(), ['commonw', 'rarezzz']);
    assert.match(best.match.text, /COMMONW COMMONW COMMONW decisive line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
