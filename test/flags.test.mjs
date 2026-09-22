// Regression tests for the flag registry (--help lists every flag), --until,
// --focus in window mode, the files_with_matches header, and the --since mtime prune.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GREP = join(here, '..', 'skills', 'session-grep', 'session-grep.mjs');
const hasRg = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !hasRg && 'ripgrep not installed';

const claudeLine = (role, body, ts) =>
  JSON.stringify({ type: role, timestamp: ts, message: { role, content: [{ type: 'text', text: body }] } }) + '\n';

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'session-grep-flags-'));
  mkdirSync(join(root, 'proj'), { recursive: true });
  writeFileSync(join(root, 'proj', 'early.jsonl'),
    claudeLine('assistant', 'SPANWORD early note', '2026-05-01T10:00:00Z'));
  writeFileSync(join(root, 'proj', 'late.jsonl'),
    claudeLine('assistant', 'SPANWORD late note', '2026-05-04T10:00:00Z'));
  writeFileSync(join(root, 'proj', 'toolonly.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-05-03T10:00:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'SPANWORD echoed inside tool output' }] } }) + '\n');
  writeFileSync(join(root, 'proj', 'big.jsonl'),
    claudeLine('assistant', `${'lead filler. '.repeat(300)}FOCUSWORD is the decisive fact.${' tail filler.'.repeat(300)}`, '2026-05-02T10:00:00Z'));
});
after(() => rmSync(root, { recursive: true, force: true }));

const run = (args) => execFileSync(process.execPath, [GREP, ...args, '--root', root], { encoding: 'utf8' });
const runJson = (args) => JSON.parse(run([...args, '--json']));

test('--help exits 0 and describes every flag the parser accepts', () => {
  const res = spawnSync(process.execPath, [GREP, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  for (const flag of ['--query', '--any', '--candidates', '--rerank', '--regex', '--session', '--at', '--focus', '--overview', '--skim',
    '--list-roots', '--limit', '--before', '--after', '--role', '--since', '--until', '--sort', '--target-type', '--source',
    '--root', '--sources-file', '--target-root', '--exclude-session', '--exclude-re', '--max-chars', '--max-tokens',
    '--include-tools', '--include-skill-bodies', '--case-sensitive', '--json', '--self-test']) {
    const line = res.stdout.split('\n').find((l) => l.startsWith(`  ${flag} `) || l.trimEnd() === `  ${flag}`);
    assert.ok(line, `${flag} missing from --help`);
    const described = line.slice(2 + flag.length).replace(/^\s*\S*/, '').trim();
    assert.ok(described.length > 0, `${flag} listed in --help with no description`);
  }
  const unknown = spawnSync(process.execPath, [GREP, '--bogus'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown arg: --bogus/);
  const dangling = spawnSync(process.execPath, [GREP, '--query'], { encoding: 'utf8' });
  assert.equal(dangling.status, 1);
  assert.match(dangling.stderr, /--query requires TEXT/);
});

test('--until includes the period it names and excludes everything after', { skip }, () => {
  const upToMay3 = runJson(['--query', 'SPANWORD', '--until', '2026-05-03']);
  assert.deepEqual(upToMay3.matches.map((m) => m.id), ['early']);
  const throughMay4 = runJson(['--query', 'SPANWORD', '--until', '2026-05-04']);
  assert.deepEqual(throughMay4.matches.map((m) => m.id).sort(), ['early', 'late']);
  assert.match(run(['--query', 'SPANWORD', '--until', '2026-05-03']), /until=2026-05-03/);
  // 'today' is an end-of-period bound like a date, not the current instant, so a
  // window of today includes a message written later today.
  const ahead = join(root, 'proj', 'ahead.jsonl');
  const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeFileSync(ahead, claudeLine('assistant', 'SPANWORD written an hour from now', soon));
  try {
    const todayOnly = runJson(['--query', 'SPANWORD', '--since', 'today', '--until', 'today']);
    assert.deepEqual(todayOnly.matches.map((m) => m.id), ['ahead']);
  } finally {
    rmSync(ahead, { force: true });
  }
  const inverted = spawnSync(process.execPath, [GREP, '--query', 'x', '--since', '2026-05-04', '--until', '2026-05-02', '--root', root], { encoding: 'utf8' });
  assert.equal(inverted.status, 1);
  assert.match(inverted.stderr, /--until must be later than --since/);
});

test('--focus centres the opened message on the given text', { skip }, () => {
  const plain = run(['--session', 'big', '--at', '0', '--before', '0', '--after', '0', '--max-chars', '700']);
  assert.doesNotMatch(plain, /FOCUSWORD/);
  const focused = run(['--session', 'big', '--at', '0', '--before', '0', '--after', '0', '--max-chars', '700', '--focus', 'FOCUSWORD']);
  assert.match(focused, /\[0\]\* assistant .*\.\.\..*FOCUSWORD is the decisive fact/);
  const misuse = spawnSync(process.execPath, [GREP, '--query', 'x', '--focus', 'y', '--root', root], { encoding: 'utf8' });
  assert.equal(misuse.status, 1);
  assert.match(misuse.stderr, /--focus requires --session ID_PREFIX --at INDEX/);
});

// toolonly.jsonl contains SPANWORD only inside a tool block, so ripgrep's prefilter
// returns three files while two produce a visible hit. The header must report the
// number the caller can act on.
test('header reports files_with_matches, not the ripgrep prefilter count', { skip }, () => {
  assert.match(run(['--query', 'SPANWORD']), /files_with_matches=2 total_message_matches=2/);
  const out = runJson(['--query', 'SPANWORD']);
  assert.equal(out.filesWithMatches, 2);
  assert.equal(out.rawFilesWithHits, 3);
  const lifted = runJson(['--query', 'SPANWORD', '--include-tools']);
  assert.equal(lifted.filesWithMatches, 3);
});

test('--since skips files last written before the window without reading them', { skip }, () => {
  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(join(root, 'proj', 'early.jsonl'), old, old);
  // early.jsonl carries a 2026-05-01 message, but its mtime says nothing newer than January
  // can be inside it, so a --since after January never opens it.
  const out = runJson(['--query', 'SPANWORD', '--since', '2026-03-01']);
  assert.equal(out.rawFilesWithHits, 2, 'early.jsonl must be pruned before it is read');
  assert.deepEqual(out.matches.map((m) => m.id), ['late']);
});
