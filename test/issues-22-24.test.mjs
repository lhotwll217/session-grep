// Regression tests for issues #22 (excluded-match signaling) and #24
// (proactive multi-word literal guidance). Search semantics are preserved:
// totalMatches counts visible hits only; the new signals are advisory.
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

const claudeLine = (role, content, ts) =>
  JSON.stringify({ type: role, timestamp: ts, message: { role, content } }) + '\n';
const text = (t) => [{ type: 'text', text: t }];

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'session-grep-22-24-'));
  mkdirSync(join(root, 'proj'), { recursive: true });
  writeFileSync(
    join(root, 'proj', 'aaaa.jsonl'),
    claudeLine('user', text('visible THINNEEDLE conversation here'), '2026-06-01T10:00:00Z') +
      claudeLine('user', [{ type: 'tool_result', content: 'TOOLONLYNEEDLE echoed inside tool output' }], '2026-06-01T10:01:00Z') +
      claudeLine('user', [{ type: 'tool_result', content: 'THINNEEDLE also inside tool output' }], '2026-06-01T10:02:00Z') +
      claudeLine('user', text('Base directory for this skill: /home/u/.claude/skills/demo-skill\n\nSKILLONLYNEEDLE inside the injected body'), '2026-06-01T10:03:00Z'),
  );
});
after(() => rmSync(root, { recursive: true, force: true }));

const run = (args) => execFileSync(process.execPath, [GREP, ...args, '--root', root], { encoding: 'utf8' });
const runJson = (args) => JSON.parse(run([...args, '--json']));

// #22: zero hits caused only by tool exclusion must say so, not read as "absent".
test('tool-only miss signals --include-tools on zero-hit path (text + json)', { skip }, () => {
  const out = run(['--query', 'TOOLONLYNEEDLE']);
  assert.match(out, /total_message_matches=0/);
  assert.match(out, /tools_excluded=1 \(add --include-tools\)/);
  assert.match(out, /1 more inside tool blocks — add --include-tools/);
  const j = runJson(['--query', 'TOOLONLYNEEDLE']);
  assert.equal(j.totalMatches, 0, 'totalMatches still counts visible hits only');
  assert.deepEqual(j.excluded, { tools: 1 });
  assert.match(j.hint, /add --include-tools/);
});

// #22: the same ambiguity exists on a thin result — signal there too.
test('thin result still reports matches hidden in tool blocks', { skip }, () => {
  const out = run(['--query', 'THINNEEDLE']);
  assert.match(out, /total_message_matches=1/);
  assert.match(out, /tools_excluded=1 \(add --include-tools\)/);
  const j = runJson(['--query', 'THINNEEDLE']);
  assert.equal(j.totalMatches, 1);
  assert.deepEqual(j.excluded, { tools: 1 });
});

// #22: the flag resolves the signal — semantics preserved, accounting cleared.
test('--include-tools recovers the hidden hit and clears the signal', { skip }, () => {
  const j = runJson(['--query', 'TOOLONLYNEEDLE', '--include-tools']);
  assert.equal(j.totalMatches, 1);
  assert.ok(!('excluded' in j), 'no exclusion to report once tools are included');
});

// #22: skill-body exclusion is accounted separately (extensible, not lumped).
test('skill-body-only miss is attributed to --include-skill-bodies', { skip }, () => {
  const j = runJson(['--query', 'SKILLONLYNEEDLE']);
  assert.equal(j.totalMatches, 0);
  assert.deepEqual(j.excluded, { skillBodies: 1 });
  assert.match(j.hint, /add --include-skill-bodies/);
  const on = runJson(['--query', 'SKILLONLYNEEDLE', '--include-skill-bodies']);
  assert.equal(on.totalMatches, 1);
  assert.ok(!('excluded' in on));
});

// #22: excluded counts honor the same --role filter as the visible search.
test('excluded counts respect --role filters', { skip }, () => {
  // Tool echoes surface under the user role; an assistant-only view hides nothing.
  const j = runJson(['--query', 'TOOLONLYNEEDLE', '--role', 'assistant']);
  assert.equal(j.totalMatches, 0);
  assert.ok(!('excluded' in j), 'role-filtered tool hit must not be reported as excluded');
});

// #24: multi-word literal guidance is proactive — present on hits, not just misses.
test('multi-word literal header advises --any while keeping literal semantics', { skip }, () => {
  const out = run(['--query', 'visible THINNEEDLE conversation']);
  assert.match(out, /literal_multiword=true \(retry with --any/);
  assert.match(out, /total_message_matches=1/, 'literal still matches literally');
  const j = runJson(['--query', 'visible THINNEEDLE conversation']);
  assert.equal(j.literalMultiword, true);
  assert.equal(j.totalMatches, 1);
});

// #24: the guidance fires only for the shape that needs it.
test('literal_multiword absent for single terms, --any, and --regex', { skip }, () => {
  assert.ok(!('literalMultiword' in runJson(['--query', 'THINNEEDLE'])));
  assert.ok(!('literalMultiword' in runJson(['--query', 'visible THINNEEDLE', '--any'])));
  assert.ok(!('literalMultiword' in runJson(['--query', 'visible THIN.*', '--regex'])));
  assert.ok(!run(['--query', 'THINNEEDLE']).includes('literal_multiword'));
});

// New header/hint bytes stay inside the charged budget.
test('new signals respect the --max-chars ceiling', { skip }, () => {
  for (const args of [
    ['--query', 'TOOLONLYNEEDLE', '--max-chars', '500'],
    ['--query', 'TOOLONLYNEEDLE', '--max-chars', '500', '--json'],
    ['--query', 'visible THINNEEDLE conversation', '--max-chars', '500'],
    ['--query', 'visible THINNEEDLE conversation', '--max-chars', '500', '--json'],
  ]) {
    const out = run(args);
    assert.ok(Buffer.byteLength(out) <= 500, `${args.join(' ')}: ${Buffer.byteLength(out)} bytes`);
  }
});

// #22 cost: a result that already fills --limit gets no excluded-match recount. The
// hidden count is a corpus-wide constant there, and computing it re-parses every
// prefilter-eligible file. Thin results (under --limit) still report it.
test('busy result carries no excluded counter; thin result does', { skip }, () => {
  const busy = runJson(['--query', 'THINNEEDLE', '--limit', '1']);
  assert.equal(busy.totalMatches, 1);
  assert.equal(busy.excluded, undefined);
  const thin = runJson(['--query', 'THINNEEDLE', '--limit', '2']);
  assert.equal(thin.totalMatches, 1);
  assert.equal(thin.excluded.tools, 1);
});
