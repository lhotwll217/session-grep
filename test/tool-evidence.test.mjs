import assert from 'node:assert/strict';
import { test } from 'node:test';
import pi from '../skills/session-grep/adapters/pi.mjs';
import claude from '../skills/session-grep/adapters/claude.mjs';
import codex from '../skills/session-grep/adapters/codex.mjs';

for (const [name, adapter, record] of [
  ['pi', pi, { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/skills/handoff/SKILL.md' } }] } }],
  ['claude', claude, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/skills/handoff/SKILL.md' } }] } }],
  ['codex', codex, { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{"path":"/skills/handoff/SKILL.md"}' } }],
]) {
  test(`${name}: tool calls are opt-in and preserve name, id, arguments`, () => {
    assert.ok(!adapter.message(record, {})?.text);
    const actual = adapter.message(record, { includeTools: true });
    assert.equal(actual.role, 'assistant');
    assert.match(actual.text, /read/i);
    assert.match(actual.text, /call-1/);
    assert.match(actual.text, /\/skills\/handoff\/SKILL.md/);
  });
}

test('nested Claude tool result and Codex function output are opt-in', () => {
  const c = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'loaded handoff skill' }] }] } };
  const x = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'loaded handoff skill' } };
  for (const [adapter, record] of [[claude, c], [codex, x]]) {
    assert.ok(!adapter.message(record, {})?.text);
    assert.match(adapter.message(record, { includeTools: true }).text, /loaded handoff skill/);
  }
});
