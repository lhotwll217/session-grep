// Unit: session-grep parses Claude-format JSONL, matches literally, bounds context, and
// respects --root. Runs against a tiny synthetic fixture built in a temp dir; needs rg.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GREP = join(here, '..', 'skills', 'session-grep', 'session-grep.mjs');
const hasRg = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;

const claudeLine = (role, text, ts) =>
  JSON.stringify({ type: role, timestamp: ts, message: { role, content: [{ type: 'text', text }] } }) + '\n';

const codexLine = (role, text, ts) =>
  JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role, content: [{ type: 'output_text', text }] } }) + '\n';

test('built-in self-test passes', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const out = execFileSync(process.execPath, [GREP, '--self-test'], { encoding: 'utf8' });
  assert.match(out, /self-test: ok/);
});

test('literal match with bounded context via --root', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    writeFileSync(
      join(root, 'proj', 'aaaa.jsonl'),
      claudeLine('user', 'first message', '2026-06-01T10:00:00Z') +
        claudeLine('assistant', 'the XYZNEEDLE answer', '2026-06-01T10:00:05Z') +
        claudeLine('user', 'follow up', '2026-06-01T10:00:10Z'),
    );
    const out = JSON.parse(
      execFileSync(process.execPath, [GREP, '--query', 'xyzneedle', '--root', root, '--json'], { encoding: 'utf8' }),
    );
    assert.equal(out.shown, 1);
    const m = out.matches[0];
    assert.equal(m.match.role, 'assistant');
    assert.equal(m.before.length, 1);
    assert.equal(m.after.length, 1);
    assert.equal(m.id, 'aaaa');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--any accepts pipe delimiters and query previews spend the available aperture', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    const decisiveTail = 'FINAL-QUIXOTIC-DECISION';
    writeFileSync(
      join(root, 'proj', 'ergonomics.jsonl'),
      claudeLine('user', 'sidebar navigation', '2026-06-01T10:00:00Z') +
        claudeLine('assistant', 'flumoxide treatment', '2026-06-01T10:00:01Z') +
        claudeLine('assistant', `quixotic evidence for the --units flag ${'bounded context '.repeat(30)}${decisiveTail}`, '2026-06-01T10:00:02Z'),
    );

    const any = JSON.parse(execFileSync(
      process.execPath,
      [GREP, '--query', 'sidebar|flumoxide|absentword', '--any', '--root', root, '--json'],
      { encoding: 'utf8' },
    ));
    assert.deepEqual(any.wordHits, { sidebar: 1, flumoxide: 1, absentword: 0 });
    assert.equal(any.totalMatches, 2, 'pipe-separated terms retain --any OR semantics');

    const preview = JSON.parse(execFileSync(
      process.execPath,
      [GREP, '--query', 'quixotic', '--before', '0', '--after', '0', '--limit', '2', '--max-chars', '4000', '--root', root, '--json'],
      { encoding: 'utf8' },
    ));
    assert.match(preview.matches[0].match.text, new RegExp(decisiveTail));

    const leadingDash = JSON.parse(execFileSync(
      process.execPath,
      [GREP, '--query', '--units', '--root', root, '--json'],
      { encoding: 'utf8' },
    ));
    assert.equal(leadingDash.totalMatches, 1, 'literal queries beginning with dashes reach ripgrep as patterns');

    const inlineCase = JSON.parse(execFileSync(
      process.execPath,
      [GREP, '--query', '(?i)QUIXOTIC', '--regex', '--root', root, '--json'],
      { encoding: 'utf8' },
    ));
    assert.equal(inlineCase.totalMatches, 1, 'common grep-style (?i) does not waste a failed search');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pi adapter and --exclude-re path blacklist', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'pi'), { recursive: true });
    const piLine = (role, content, ts) =>
      JSON.stringify({ type: 'message', id: 'ab12cd34', parentId: null, timestamp: ts, message: { role, content } }) + '\n';
    writeFileSync(
      join(root, 'pi', '2026-06-10T08-00-00_cccc.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: 'cccc', timestamp: '2026-06-10T08:00:00Z', cwd: '/tmp' }) + '\n' +
        piLine('user', 'PINEEDLE from the pi harness', '2026-06-10T08:00:01Z') +
        piLine('assistant', [{ type: 'text', text: 'PINEEDLE answered' }], '2026-06-10T08:00:02Z'),
    );
    const out = JSON.parse(
      execFileSync(process.execPath, [GREP, '--query', 'pineedle', '--root', root, '--json'], { encoding: 'utf8' }),
    );
    assert.equal(out.shown, 2);
    assert.ok(out.matches.every((m) => m.source === 'pi'));
    const excluded = JSON.parse(
      execFileSync(process.execPath, [GREP, '--query', 'pineedle', '--root', root, '--exclude-re', 'cccc', '--json'], { encoding: 'utf8' }),
    );
    assert.equal(excluded.totalMatches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('role filter and case sensitivity', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    writeFileSync(
      join(root, 'proj', 'bbbb.jsonl'),
      claudeLine('user', 'needle in user', '2026-06-01T10:00:00Z') +
        claudeLine('assistant', 'NEEDLE in assistant', '2026-06-01T10:00:05Z'),
    );
    const userOnly = JSON.parse(
      execFileSync(process.execPath, [GREP, '--query', 'needle', '--root', root, '--role', 'user', '--json'], { encoding: 'utf8' }),
    );
    assert.equal(userOnly.shown, 1);
    assert.equal(userOnly.matches[0].match.role, 'user');
    const caseSensitive = JSON.parse(
      execFileSync(process.execPath, [GREP, '--query', 'NEEDLE', '--root', root, '--case-sensitive', '--json'], { encoding: 'utf8' }),
    );
    assert.equal(caseSensitive.shown, 1);
    assert.equal(caseSensitive.matches[0].match.role, 'assistant');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate grouping happens before limit and stable-id exclusion is semantic', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    writeFileSync(
      join(root, 'proj', 'aaaa.jsonl'),
      claudeLine('user', 'shared needle alpha one', '2026-06-01T10:00:00Z') +
        claudeLine('assistant', 'shared needle alpha two', '2026-06-01T10:00:01Z') +
        claudeLine('assistant', 'shared needle alpha three', '2026-06-01T10:00:02Z'),
    );
    writeFileSync(join(root, 'proj', 'bbbb.jsonl'), claudeLine('assistant', 'shared needle beta', '2026-06-01T10:01:00Z'));
    const grouped = JSON.parse(execFileSync(
      process.execPath,
      [GREP, '--query', 'shared needle', '--root', root, '--candidates', '--limit', '2', '--json'],
      { encoding: 'utf8' },
    ));
    assert.equal(grouped.totalMatches, 4);
    assert.equal(grouped.totalCandidateSessions, 2);
    assert.deepEqual(new Set(grouped.candidates.map((candidate) => candidate.id)), new Set(['aaaa', 'bbbb']));
    assert.equal(grouped.candidates.find((candidate) => candidate.id === 'aaaa').hitCount, 3);

    const excluded = JSON.parse(execFileSync(
      process.execPath,
      [GREP, '--query', 'shared needle', '--root', root, '--exclude-session', 'aaaa', '--json'],
      { encoding: 'utf8' },
    ));
    assert.deepEqual(excluded.matches.map((match) => match.id), ['bbbb']);
    assert.deepEqual(excluded.excludedSessions, ['aaaa']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex rollout filenames skim by canonical session UUID', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    const id = '0198a111-2222-7333-8444-555555555555';
    mkdirSync(join(root, 'codex'), { recursive: true });
    const longAnswer = `${'context '.repeat(35)}TAILFACT-48-CHECKS`;
    writeFileSync(
      join(root, 'codex', `rollout-2026-07-10T08-30-00-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', timestamp: '2026-07-10T08:30:00Z', payload: { id, cwd: '/tmp', originator: 'codex_cli' } }) + '\n' +
        codexLine('user', 'trace the canonical id path', '2026-07-10T08:30:01Z') +
        codexLine('assistant', `canonical id lookup works ${longAnswer}`, '2026-07-10T08:30:02Z'),
    );

    const out = execFileSync(process.execPath, [GREP, '--skim', id, '--root', join(root, 'codex'), '--max-chars', '2000'], { encoding: 'utf8' });
    assert.match(out, new RegExp(`skim id=${id}`));
    assert.match(out, /canonical id lookup works/);
    assert.match(out, /TAILFACT-48-CHECKS/, 'short skims use the available budget instead of clipping every message at 200 chars');
    const window = execFileSync(process.execPath, [GREP, '--session', id, '--at', '1', '--root', join(root, 'codex'), '--max-chars', '2000'], { encoding: 'utf8' });
    assert.match(window, /TAILFACT-48-CHECKS/, 'pointer drill-in spends the aperture on the selected message');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skim max-chars is a hard rendered-output budget', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    writeFileSync(
      join(root, 'proj', 'budget.jsonl'),
      Array.from({ length: 40 }, (_, index) =>
        claudeLine(index % 2 ? 'assistant' : 'user', `long message ${index} ${'context '.repeat(80)}`, `2026-06-01T10:${String(index).padStart(2, '0')}:00Z`),
      ).join(''),
    );
    const out = execFileSync(
      process.execPath,
      [GREP, '--skim', 'budget', '--root', root, '--max-chars', '1200'],
      { encoding: 'utf8' },
    );
    assert.ok(Buffer.byteLength(out) <= 1200, `skim rendered ${Buffer.byteLength(out)} bytes for a 1200-character budget`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('anchored windows retain the selected target before spending context budget', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    writeFileSync(
      join(root, 'proj', 'anchored.jsonl'),
      Array.from({ length: 6 }, (_, index) =>
        claudeLine('user', `lead-in ${index} ${'context '.repeat(90)}`, `2026-06-01T10:0${index}:00Z`),
      ).join('') + claudeLine('assistant', 'ANCHOR-TARGET is the selected evidence', '2026-06-01T10:06:00Z'),
    );
    const out = execFileSync(
      process.execPath,
      [GREP, '--session', 'anchored', '--at', '6', '--before', '5', '--after', '0', '--max-chars', '500', '--root', root],
      { encoding: 'utf8' },
    );
    assert.match(out, /\[6\]\*/);
    assert.match(out, /ANCHOR-TARGET/);
    assert.match(out, /selected \[6\] retained/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('query can scope to one session while genuinely ambiguous modes fail closed', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    mkdirSync(join(root, 'proj'), { recursive: true });
    writeFileSync(
      join(root, 'proj', 'aaaa.jsonl'),
      Array.from({ length: 8 }, (_, index) =>
        claudeLine(index % 2 ? 'assistant' : 'user', `mode needle ${index} ${'context '.repeat(30)}`, `2026-06-01T10:0${index}:00Z`),
      ).join(''),
    );
    writeFileSync(join(root, 'proj', 'bbbb.jsonl'), claudeLine('user', 'another mode needle', '2026-06-01T10:01:00Z'));
    const scoped = JSON.parse(execFileSync(
      process.execPath,
      [GREP, '--query', 'needle', '--session', 'aaaa', '--root', root, '--json'],
      { encoding: 'utf8' },
    ));
    assert.equal(scoped.session, 'aaaa');
    assert.ok(scoped.matches.length > 1 && scoped.matches.every((match) => match.id === 'aaaa'));
    const tight = execFileSync(
      process.execPath,
      [GREP, '--query', 'needle', '--session', 'aaaa', '--root', root, '--max-chars', '600'],
      { encoding: 'utf8' },
    );
    assert.match(tight, /stay in this --session scope/);

    const ambiguous = spawnSync(
      process.execPath,
      [GREP, '--query', 'needle', '--session', 'aaaa', '--at', '0', '--root', root],
      { encoding: 'utf8' },
    );
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /choose exactly one mode/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('typed sources file supports target root and target type narrowing', { skip: !hasRg && 'ripgrep not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'session-grep-test-'));
  try {
    const ooSessions = join(root, 'owner-sessions');
    const relocatedCodex = join(root, 'relocated-store');
    mkdirSync(ooSessions, { recursive: true });
    mkdirSync(relocatedCodex, { recursive: true });

    const piLine = (role, content, ts) =>
      JSON.stringify({ type: 'message', id: 'ab12cd34', parentId: null, timestamp: ts, message: { role, content } }) + '\n';
    writeFileSync(
      join(ooSessions, '2026-06-10T08-00-00_oooo.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: 'oooo', timestamp: '2026-06-10T08:00:00Z', cwd: '/tmp' }) + '\n' +
        piLine('assistant', [{ type: 'text', text: 'OONEEDLE from an owner operator session path' }], '2026-06-10T08:00:02Z'),
    );
    writeFileSync(
      join(relocatedCodex, 'rollout-cccc.jsonl'),
      codexLine('assistant', 'CODEXNEEDLE from a relocated codex store', '2026-06-11T08:00:00Z'),
    );

    const sourcesFile = join(root, 'sources.json');
    writeFileSync(sourcesFile, JSON.stringify([
      { type: 'pi', root: ooSessions },
      { type: 'codex', root: relocatedCodex },
    ]));

    const oo = JSON.parse(
      execFileSync(process.execPath, [GREP, '--sources-file', sourcesFile, '--target-root', ooSessions, '--query', 'ooneedle', '--json'], { encoding: 'utf8' }),
    );
    assert.equal(oo.totalMatches, 1);
    assert.equal(oo.matches[0].source, 'pi');

    const targetRootMiss = JSON.parse(
      execFileSync(process.execPath, [GREP, '--sources-file', sourcesFile, '--target-root', ooSessions, '--query', 'codexneedle', '--json'], { encoding: 'utf8' }),
    );
    assert.equal(targetRootMiss.totalMatches, 0);

    const codexOnly = JSON.parse(
      execFileSync(process.execPath, [GREP, '--sources-file', sourcesFile, '--target-type', 'codex', '--query', 'codexneedle', '--json'], { encoding: 'utf8' }),
    );
    assert.equal(codexOnly.totalMatches, 1);
    assert.equal(codexOnly.matches[0].source, 'codex');

    const legacySourceAlias = JSON.parse(
      execFileSync(process.execPath, [GREP, '--sources-file', sourcesFile, '--source', 'codex', '--query', 'codexneedle', '--json'], { encoding: 'utf8' }),
    );
    assert.equal(legacySourceAlias.totalMatches, 1);
    assert.equal(legacySourceAlias.matches[0].source, 'codex');

    const envOnlySources = join(root, 'env-only-sources.json');
    writeFileSync(envOnlySources, JSON.stringify([{ type: 'pi', root: ooSessions }]));
    const flagWins = JSON.parse(
      execFileSync(process.execPath, [GREP, '--sources-file', sourcesFile, '--query', 'codexneedle', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, SESSION_GREP_SOURCES_FILE: envOnlySources },
      }),
    );
    assert.equal(flagWins.totalMatches, 1);
    assert.equal(flagWins.matches[0].source, 'codex');

    const missingSources = spawnSync(process.execPath, [GREP, '--list-roots', '--sources-file', join(root, 'missing.json')], { encoding: 'utf8' });
    assert.equal(missingSources.status, 1);
    assert.match(missingSources.stderr, /--sources-file/);
    assert.doesNotMatch(missingSources.stdout, /origin=/);

    const rootWithSources = spawnSync(process.execPath, [GREP, '--query', 'ooneedle', '--root', ooSessions, '--sources-file', sourcesFile], { encoding: 'utf8' });
    assert.equal(rootWithSources.status, 1);
    assert.match(rootWithSources.stderr, /cannot be combined/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
