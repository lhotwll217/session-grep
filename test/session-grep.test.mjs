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
