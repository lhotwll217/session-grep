// OpenCode sessions: ~/.local/share/opencode/opencode.db. OpenCode stores
// messages and their parts in SQLite rather than one JSONL file per session.
// materialize() exports the conversational parts to temporary JSONL so the
// shared search, ranking, budgeting, and pointer code can stay format-agnostic.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { contentToText } from './_shared.mjs';

const materialized = new Map();

function databaseAt(root) {
  if (path.basename(root) === 'opencode.db') return root;
  return path.join(root, 'opencode.db');
}

function sqliteRows(database, query, visit) {
  return new Promise((resolve) => {
    const child = spawn('sqlite3', ['-batch', '-noheader', database, query], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let error = null;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', (cause) => {
      error = `sqlite3 is required to read OpenCode sessions (${cause.code ?? cause.message})`;
    });
    lines.on('line', (line) => {
      if (!line || error) return;
      try {
        visit(line);
      } catch (cause) {
        error = `could not materialize OpenCode sessions: ${cause.message}`;
        child.kill();
      }
    });
    child.on('close', (code) => {
      if (!error && code !== 0) error = stderr.trim() || `sqlite3 exited with status ${code}`;
      resolve(error);
    });
  });
}

function partContent(row, includeTools) {
  if (row.part_type === 'text' && typeof row.text === 'string') {
    if (row.synthetic) {
      return includeTools ? { type: 'tool_result', content: row.text } : null;
    }
    return { type: 'text', text: row.text };
  }
  if (includeTools && row.part_type === 'tool') {
    const value = row.tool_output ?? row.tool_error;
    if (value != null) {
      return {
        type: 'tool_result',
        content: typeof value === 'string' ? value : JSON.stringify(value),
      };
    }
  }
  return null;
}

export default {
  name: 'opencode',
  detect: (file) => materialized.has(file) || file.includes('/.local/share/opencode/'),
  detectRoot: (root) => fs.existsSync(databaseAt(root)),
  async materialize(root, destination, opts = {}) {
    const database = databaseAt(root);
    if (!fs.existsSync(database)) return { roots: [] };

    const types = opts.includeTools ? "('text','tool')" : "('text')";
    const query = `
      SELECT json_object(
        'session_id', m.session_id,
        'message_id', m.id,
        'role', json_extract(m.data, '$.role'),
        'time_created', m.time_created,
        'part_type', json_extract(p.data, '$.type'),
        'text', json_extract(p.data, '$.text'),
        'synthetic', coalesce(json_extract(p.data, '$.synthetic'), 0),
        'tool_output', json_extract(p.data, '$.state.output'),
        'tool_error', json_extract(p.data, '$.state.error'),
        'directory', s.directory
      )
      FROM message m
      JOIN part p ON p.message_id = m.id
      JOIN session s ON s.id = m.session_id
      WHERE json_extract(m.data, '$.role') IN ('user', 'assistant')
        AND json_extract(p.data, '$.type') IN ${types}
      ORDER BY m.session_id, m.time_created, m.id, p.time_created, p.id
    `;
    fs.mkdirSync(destination, { recursive: true });
    let sessionId = null;
    let messageId = null;
    let output = null;
    let message = null;
    const flushMessage = () => {
      if (output == null || !message?.message.content.length) return;
      fs.writeSync(output, `${JSON.stringify(message)}\n`);
    };
    const closeSession = () => {
      flushMessage();
      if (output != null) fs.closeSync(output);
      output = null;
      message = null;
      messageId = null;
    };
    const visit = (line) => {
      let row;
      try { row = JSON.parse(line); } catch { return; }
      const content = partContent(row, opts.includeTools);
      if (!content) return;
      if (row.session_id !== sessionId) {
        closeSession();
        sessionId = row.session_id;
        const file = path.join(destination, `${sessionId}.jsonl`);
        output = fs.openSync(file, 'w', 0o600);
        materialized.set(file, { database, directory: row.directory, sessionId });
      }
      if (row.message_id !== messageId) {
        flushMessage();
        messageId = row.message_id;
        message = {
          type: 'opencode_message',
          timestamp: new Date(row.time_created).toISOString(),
          message: { role: row.role, content: [] },
        };
      }
      message.message.content.push(content);
    };
    let error;
    try {
      error = await sqliteRows(database, query, visit);
      closeSession();
    } finally {
      if (output != null) fs.closeSync(output);
    }
    if (error) return { roots: [], error };
    return { roots: [destination] };
  },
  displayPath(file) {
    const meta = materialized.get(file);
    if (!meta) return file;
    return `${meta.database}#${meta.sessionId} (${meta.directory})`;
  },
  backingPath(file) {
    return materialized.get(file)?.database ?? file;
  },
  message(obj, opts) {
    if (obj.type !== 'opencode_message' || !obj.message) return null;
    const role = obj.message.role;
    if (!['user', 'assistant'].includes(role)) return null;
    return {
      role,
      text: contentToText(obj.message.content, opts),
      timestamp: obj.timestamp,
    };
  },
};
