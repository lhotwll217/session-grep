import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GREP = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'session-grep', 'session-grep.mjs');

let root;
const line = (text) => JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T09:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
const setup = () => {
  root = mkdtempSync(join(tmpdir(), 'session-grep-origin-'));
  writeFileSync(join(root, 'a.jsonl'), line('needle here'));
  return root;
};
const run = (args, env) => execFileSync(process.execPath, [GREP, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('a search on the built-in defaults says so, without being asked', () => {
  const r = setup();
  const out = run(['--query', 'needle', '--limit', '1', '--max-chars', '900'], { SESSION_GREP_SOURCES_FILE: '' });
  assert.match(out.split('\n')[0], /sources=defaults \(see --list-roots\)/);
  rmSync(r, { recursive: true, force: true });
});

test('a configured search says nothing, so a set-up machine pays no noise', () => {
  const r = setup();
  const cfg = join(r, 'sources.json');
  writeFileSync(cfg, JSON.stringify([{ type: 'claude', root: r }]));
  const out = run(['--query', 'needle', '--limit', '1', '--max-chars', '900'], { SESSION_GREP_SOURCES_FILE: cfg });
  assert.doesNotMatch(out.split('\n')[0], /sources=defaults/);
  rmSync(r, { recursive: true, force: true });
});

test('the JSON envelope carries the same signal for an agent', () => {
  const r = setup();
  const bare = JSON.parse(run(['--query', 'needle', '--limit', '1', '--max-chars', '900', '--json'], { SESSION_GREP_SOURCES_FILE: '' }));
  assert.equal(bare.sourcesOrigin, 'defaults');
  const cfg = join(r, 'sources.json');
  writeFileSync(cfg, JSON.stringify([{ type: 'claude', root: r }]));
  const configured = JSON.parse(run(['--query', 'needle', '--limit', '1', '--max-chars', '900', '--json'], { SESSION_GREP_SOURCES_FILE: cfg }));
  assert.equal(configured.sourcesOrigin, undefined);
  rmSync(r, { recursive: true, force: true });
});
