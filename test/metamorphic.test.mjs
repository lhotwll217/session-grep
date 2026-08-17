// Metamorphic relations: ranked retrieval has no golden-output oracle, so assert
// relations between runs instead — budget dominance across encodings, budget
// monotonicity, scope consistency, pointer round-trip, and adapter equivalence
// (the same logical conversation encoded as Claude, Codex, and Pi JSONL must parse
// to identical roles, texts, and ordering).
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

// One logical conversation — ASCII, CJK, emoji, combining marks, and a multipart
// message — encoded three ways. Tool echoes (a Claude tool_result-only message and
// a Pi toolResult message; Codex keeps tool output outside message records) are
// interleaved and must vanish identically under the default tool exclusion.
const CONVO = [
  { role: 'user', parts: ['alpha question about KOALA9 rollout timing'], ts: '2026-06-10T08:00:01Z' },
  { role: 'assistant', parts: ['the KOALA9 rollout failed with ENOSPACE on the runner'], ts: '2026-06-10T08:00:02Z' },
  { role: 'user', parts: ['現地時間のバグを修正して KOALA9 を再デプロイして'], ts: '2026-06-10T08:00:03Z' },
  { role: 'assistant', parts: ['fixed and redeployed KOALA9 🚀 with emoji notes 🔥'], ts: '2026-06-10T08:00:04Z' },
  { role: 'assistant', parts: ['multipart résumé of the KOALA9 work', 'second part with a combining séquence'], ts: '2026-06-10T08:00:05Z' },
];

const encodeClaude = (m) =>
  JSON.stringify({ type: m.role, timestamp: m.ts, message: { role: m.role, content: m.parts.map((text) => ({ type: 'text', text })) } }) + '\n';
const encodeCodex = (m) =>
  JSON.stringify({ type: 'response_item', timestamp: m.ts, payload: { type: 'message', role: m.role, content: m.parts.map((text) => ({ type: m.role === 'user' ? 'input_text' : 'output_text', text })) } }) + '\n';
const encodePi = (m, i) =>
  JSON.stringify({ type: 'message', id: `id${i}`, parentId: i ? `id${i - 1}` : null, timestamp: m.ts, message: { role: m.role, content: m.parts.map((text) => ({ type: 'text', text })) } }) + '\n';

const claudeToolNoise = JSON.stringify({ type: 'user', timestamp: '2026-06-10T08:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'TOOLNOISE KOALA9 echoed in tool output' }] } }) + '\n';
const piToolNoise = JSON.stringify({ type: 'message', id: 'tool1', parentId: 'id1', timestamp: '2026-06-10T08:00:02Z', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'TOOLNOISE KOALA9 echoed in tool output' }], isError: false } }) + '\n';

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'session-grep-meta-'));
  mkdirSync(join(root, 'proj'), { recursive: true });
  mkdirSync(join(root, 'codex'), { recursive: true });
  mkdirSync(join(root, 'pi'), { recursive: true });
  const claudeLines = CONVO.map(encodeClaude);
  claudeLines.splice(2, 0, claudeToolNoise);
  writeFileSync(join(root, 'proj', 'claudeaaaa.jsonl'), claudeLines.join(''));
  writeFileSync(join(root, 'codex', 'rollout-bbbb.jsonl'), CONVO.map(encodeCodex).join(''));
  const piLines = CONVO.map(encodePi);
  piLines.splice(2, 0, piToolNoise);
  writeFileSync(
    join(root, 'pi', '2026-06-10T08-00-00_pipi.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'pipi', timestamp: '2026-06-10T08:00:00Z', cwd: '/tmp' }) + '\n' + piLines.join(''),
  );
  // Volume fixture: 150 short hits to exercise 100+ index prefixes under the budget.
  const many = Array.from({ length: 150 }, (_, i) =>
    JSON.stringify({ type: 'user', timestamp: `2026-06-11T0${Math.floor(i / 60) % 10}:${String(i % 60).padStart(2, '0')}:00Z`, message: { role: 'user', content: [{ type: 'text', text: `MANYHIT filler message number ${i}` }] } }) + '\n').join('');
  writeFileSync(join(root, 'proj', 'manyhits.jsonl'), many);
  // Emoji session for tiny-budget skim: head and tail must both survive sampling.
  const emo = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ type: 'user', timestamp: `2026-06-12T08:00:0${i}Z`, message: { role: 'user', content: [{ type: 'text', text: `🚀🔥 emoji message number ${i} ${'x'.repeat(100)}` }] } }) + '\n').join('');
  writeFileSync(join(root, 'proj', 'emojisess.jsonl'), emo);
});
after(() => rmSync(root, { recursive: true, force: true }));

const run = (args) => execFileSync(process.execPath, [GREP, ...args, '--root', root], { encoding: 'utf8' });
const runJson = (args) => JSON.parse(run([...args, '--json']));
const key = (m) => `${m.id}:${m.index}`;

test('adapter equivalence: three encodings parse to identical roles, texts, ordering', { skip }, () => {
  const out = runJson(['--query', 'koala9', '--limit', '50', '--max-chars', '30000']);
  const bySource = {};
  for (const m of out.matches) (bySource[m.source] ??= []).push(m);
  assert.deepEqual(Object.keys(bySource).sort(), ['claude', 'codex', 'pi']);
  const shape = (ms) => ms.sort((a, b) => a.index - b.index).map((m) => `${m.index}|${m.match.role}|${m.match.text}`);
  const claude = shape(bySource.claude.filter((m) => m.id === 'claudeaaaa'));
  assert.deepEqual(shape(bySource.codex), claude);
  assert.deepEqual(shape(bySource.pi), claude);
  assert.equal(claude.length, CONVO.length);
});

test('adapter equivalence: tool echoes are excluded identically, indexes unshifted', { skip }, () => {
  // The noise mentions KOALA9; with default exclusion it must match nowhere and the
  // conversational indexes must be identical across encodings despite the extra records.
  const noise = runJson(['--query', 'TOOLNOISE', '--limit', '50', '--max-chars', '30000']);
  assert.equal(noise.totalMatches, 0);
  const withTools = runJson(['--query', 'TOOLNOISE', '--limit', '50', '--max-chars', '30000', '--include-tools']);
  assert.deepEqual(withTools.matches.map((m) => m.source).sort(), ['claude', 'pi']);
});

test('budget dominance: rendered bytes <= budget for every mode and encoding', { skip }, () => {
  for (const budget of [500, 900, 1600]) {
    for (const args of [
      ['--query', 'koala9', '--limit', '50'],
      ['--query', 'koala9', '--limit', '50', '--json'],
      ['--query', '現地時間', '--limit', '50'],
      ['--query', 'koala9 rollout 現地時間', '--any', '--limit', '50'],
      ['--overview'],
      ['--skim', 'claudeaaaa'],
      ['--skim', '2026-06-10T08-00-00_pipi'],
      ['--session', 'claudeaaaa', '--at', '2'],
    ]) {
      const out = run([...args, '--max-chars', String(budget)]);
      assert.ok(
        Buffer.byteLength(out) <= budget,
        `${args.join(' ')} @ ${budget}: ${Buffer.byteLength(out)} bytes`,
      );
    }
  }
});

test('budget dominance under volume: 100+ rendered hits stay under the ceiling', { skip }, () => {
  const out = run(['--query', 'MANYHIT', '--limit', '200', '--before', '0', '--after', '0', '--max-chars', '22000']);
  assert.ok(Buffer.byteLength(out) <= 22000, `${Buffer.byteLength(out)} bytes`);
  assert.ok(Number(out.match(/shown=(\d+)/)[1]) >= 100, 'fixture must actually render 100+ hits');
});

test('tiny-budget skim keeps head and tail', { skip }, () => {
  const out = run(['--skim', 'emojisess', '--max-chars', '500']);
  assert.ok(Buffer.byteLength(out) <= 500, `${Buffer.byteLength(out)} bytes`);
  assert.ok(out.includes('[0]'), 'head missing');
  assert.ok(out.includes('[4]'), 'tail missing');
});

test('--max-tokens N is exactly --max-chars 4N', { skip }, () => {
  const byChars = run(['--query', 'koala9', '--limit', '50', '--max-chars', '600']);
  const byTokens = run(['--query', 'koala9', '--limit', '50', '--max-tokens', '150']);
  assert.equal(byTokens, byChars);
});

test('--session without a query or --at is rejected, not silently ignored', { skip }, () => {
  const res = spawnSync(process.execPath, [GREP, '--session', 'claudeaaaa', '--root', root], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--session requires --query TEXT or --at INDEX/);
});

test('session scope consistency: --query --session returns exactly the global subset', { skip }, () => {
  const all = runJson(['--query', 'koala9', '--limit', '50', '--max-chars', '30000']);
  const scoped = runJson(['--query', 'koala9', '--session', 'claudeaaaa', '--limit', '50', '--max-chars', '30000']);
  assert.equal(scoped.session, 'claudeaaaa');
  assert.deepEqual(
    scoped.matches.map(key).sort(),
    all.matches.filter((m) => m.id === 'claudeaaaa').map(key).sort(),
  );
});

test('budget monotonicity: raising --max-chars never shrinks the emitted set', { skip }, () => {
  let prevShown = -1;
  let prevKeys = new Set();
  for (const budget of [600, 900, 1400, 4000]) {
    const out = runJson(['--query', 'koala9', '--limit', '50', '--max-chars', String(budget)]);
    assert.ok(out.shown >= prevShown, `shown fell from ${prevShown} to ${out.shown} at ${budget}`);
    const keys = new Set(out.matches.map(key));
    for (const k of prevKeys) assert.ok(keys.has(k), `${k} vanished when budget rose to ${budget}`);
    prevShown = out.shown;
    prevKeys = keys;
  }
});

test('scope consistency: --source and --role return exact subsets of the global result', { skip }, () => {
  const all = runJson(['--query', 'koala9', '--limit', '50', '--max-chars', '30000']);
  const codexOnly = runJson(['--query', 'koala9', '--limit', '50', '--max-chars', '30000', '--source', 'codex']);
  assert.deepEqual(
    codexOnly.matches.map(key).sort(),
    all.matches.filter((m) => m.source === 'codex').map(key).sort(),
  );
  const assistants = runJson(['--query', 'koala9', '--limit', '50', '--max-chars', '30000', '--role', 'assistant']);
  assert.deepEqual(
    assistants.matches.map(key).sort(),
    all.matches.filter((m) => m.match.role === 'assistant').map(key).sort(),
  );
});

test('pointer round-trip: every emitted id/idx resolves and centres on the hit', { skip }, () => {
  const all = runJson(['--query', 'koala9', '--limit', '50', '--max-chars', '30000']);
  assert.ok(all.matches.length > 0);
  for (const m of all.matches) {
    const win = run(['--session', m.id.slice(0, 10), '--at', String(m.index), '--max-chars', '4000']);
    assert.ok(win.includes(`[${m.index}]*`), `window for ${key(m)} did not centre on idx`);
    assert.match(win, /KOALA9/i);
  }
});
