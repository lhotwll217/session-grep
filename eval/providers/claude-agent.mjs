// Promptfoo provider: runs Claude Code headless (`claude -p`) as the eval subject.
// Two arms share this file, selected by config.arm:
//   'session-grep' — instructed + permitted to use bin/session-grep.mjs
//   'naive-grep'   — instructed to use plain rg/grep/Read over the raw JSONL
// Both arms get an identical read-only tool surface otherwise, so the measured
// difference is the search strategy, not the harness.
//
// Efficiency data comes from two places: the final result envelope (usage, cost,
// turns, duration) and the stream-json trajectory (tool calls, chars returned per
// tool result). The full trajectory is written to eval/results/logs/ so the
// auto-research loop can inspect HOW each arm searched, not just what it cost.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
// Corpus under test. The MAIN suite's haystack is FROZEN to the claude fixtures the
// original 29 cases were mined from — changing the corpus under existing cases breaks
// run-to-run comparability. Other corpora (the codex format-parity conversion, the
// real-rollout extension suite) are selected explicitly via SESSION_GREP_EVAL_FIXTURES,
// never by editing this default.
const FIXTURES_SRC = process.env.SESSION_GREP_EVAL_FIXTURES
  ?? path.join(repoRoot, 'eval', 'fixtures', 'claude', 'owner-operator');

// Subjects run in a sandbox containing ONLY the transcripts, located OUTSIDE the repo
// tree: from inside the repo, `rg ../cases.yaml`-style wandering could reach the answer
// key (codex review P0; trajectory audit of 257 runs found it was never exploited, but
// the capability must not exist). The sandbox is re-synced whenever the fixtures are
// newer than the last copy, so fixture edits can't go stale (review P1).
const SANDBOX = path.join(os.tmpdir(), 'session-grep-eval-sandbox');
const TRANSCRIPTS = path.join(SANDBOX, 'transcripts');
const STAMP = path.join(SANDBOX, '.synced-at');
const fixturesMtime = Math.max(...fs.readdirSync(FIXTURES_SRC, { recursive: true }).map((f) => fs.statSync(path.join(FIXTURES_SRC, String(f))).mtimeMs));
const syncedAt = fs.existsSync(STAMP) ? Number(fs.readFileSync(STAMP, 'utf8')) : 0;
if (!fs.existsSync(TRANSCRIPTS) || fixturesMtime > syncedAt) {
  fs.rmSync(TRANSCRIPTS, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.cpSync(FIXTURES_SRC, TRANSCRIPTS, { recursive: true });
  fs.writeFileSync(STAMP, String(Date.now()));
}

const GREP_BIN = path.join(repoRoot, 'bin', 'session-grep.mjs');

const COMMON_RULES = `The transcripts are your ONLY source of truth. Do not answer from your own memory, general knowledge, or any other files — always search the transcripts first. In the questions, "we"/"I" refer to the user and agent INSIDE those transcripts (a project called owner-operator), not to you or this environment.

Your working directory IS the sandbox: the transcripts are at ./transcripts relative to where you already are. Use relative paths only — never cd, never absolute paths, never explore directories outside the current one; everything you need is here.

Your search commands are pre-approved — run them directly and NEVER ask the user for permission. If a command is denied, re-run it exactly in the form shown above (no cd prefixes); do not give up.

Answer the question factually and concisely, citing which session (file id) the answer came from. If you cannot find the answer in the transcripts, say so plainly rather than guessing.`;

const SKILL_ARM_PROMPT = `You answer questions about past AI coding sessions recorded as JSONL transcripts in ./transcripts (June-July 2026). Sessions may come from different tools (Claude Code, Codex CLI); the search tool handles all supported formats transparently.

Search them with the session-grep tool:
  node ${GREP_BIN} --query TEXT --root transcripts [flags]
Flags: --any (multi-word query: matches ANY word, hits ranked by how many words match — use this when you have several candidate terms), --regex (JS regex query), --limit N (default 20), --before N / --after N (messages of context around each hit, default 1), --role user|assistant|all, --since today|Nd|YYYY-MM-DD, --sort newest|oldest, --case-sensitive, --max-chars N (output budget, default 8000), --json.

Browse modes (no --query needed):
  --overview                    one-line digest per session: id, dates, sizes, opening prompt
  --skim SESSION_ID_PREFIX     the conversation of ONE session, sampled to fit the budget
  --session ID_PREFIX --at N    drill into a hit: every hit prints id= and idx= — this returns
                                the exact messages around that index (default +/-5). Use this to
                                read around a promising hit instead of re-searching with wider context.

Strategy: for broad questions (summarize a session, how could X have gone better, what was session Y about) start with --overview, then --skim on the right session — and remember a skim is a SAMPLE of the conversation, so verify key claims with targeted probes before answering. For fact questions: a multi-word literal query almost never matches — use --any for multi-word searches, or a single rare term (identifier, error string, unusual noun). Issue several small targeted searches rather than one broad one. The raw .jsonl files are enormous and ~98% tool-call noise; do not cat/Read them wholesale.

${COMMON_RULES}`;

const NAIVE_ARM_PROMPT = `You answer questions about past AI coding sessions recorded as JSONL transcripts in ./transcripts (June-July 2026). Sessions may come from different tools (Claude Code, Codex CLI).

Search them however you like with standard tools: rg/grep via Bash, the Grep tool, and Read. Each JSONL line is one JSON record. Claude format: messages under .message.content. Codex format: {type:"response_item", payload:{type:"message", role, content}} lines.

${COMMON_RULES}`;

// Both arms share the same generic read-only floor — in dontAsk mode anything off the
// allowlist reads as a denial and small models give up, which measures permission-fu
// instead of search strategy. The skill arm ADDS its tool on top of the shared floor;
// the measured delta is the tool's value, which is the honest real-world comparison.
const BASE_TOOLS = 'Bash(rg*),Bash(grep*),Bash(cat*),Bash(head*),Bash(tail*),Bash(wc*),Bash(sed*),Bash(awk*),Bash(jq*),Bash(ls*),Bash(find*),Bash(xargs*),Bash(sort*),Bash(uniq*),Bash(cut*),Bash(tr*),Bash(python3*)';

const ARMS = {
  'session-grep': {
    systemPrompt: SKILL_ARM_PROMPT,
    // Cover the invocation forms agents actually produce (absolute and relative);
    // a missed prefix reads as a permission denial and haiku gives up.
    allowedTools: `${BASE_TOOLS},Bash(node ${GREP_BIN}*),Bash(node bin/session-grep.mjs*),Bash(node ../bin/session-grep.mjs*),Bash(node ../../bin/session-grep.mjs*)`,
  },
  'naive-grep': {
    systemPrompt: NAIVE_ARM_PROMPT,
    allowedTools: BASE_TOOLS,
  },
};

const DISALLOWED = 'Task,WebSearch,WebFetch,TodoWrite,Write,Edit,MultiEdit,NotebookEdit,Skill';

// One run id ties the audit trail together: loop.mjs sets SESSION_GREP_RUN_ID so the
// trajectory log dir, the iteration detail file, and the history.jsonl record all
// share the same stamp. Standalone promptfoo runs fall back to their own timestamp.
const runStamp = process.env.SESSION_GREP_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export default class ClaudeAgentProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.arm = this.config.arm ?? 'session-grep';
    if (!ARMS[this.arm]) throw new Error(`Unknown arm: ${this.arm}`);
    // Model is part of the benchmark matrix: config.model is authoritative so a run
    // never silently inherits the interactive session's (possibly expensive) default.
    this.model = this.config.model ?? process.env.EVAL_MODEL ?? 'haiku';
    this.providerId = options.id ?? `claude-agent:${this.arm}:${this.model}`;
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const arm = ARMS[this.arm];
    const model = this.model;
    const maxTurns = this.config.maxTurns ?? 25;
    const maxBudgetUsd = this.config.maxBudgetUsd ?? 1.0;
    const timeoutMs = this.config.timeoutMs ?? 15 * 60 * 1000;
    const caseId = context?.vars?.id ?? 'case';

    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', String(maxTurns),
      '--max-budget-usd', String(maxBudgetUsd),
      '--append-system-prompt', arm.systemPrompt,
      '--allowedTools', arm.allowedTools,
      '--disallowedTools', DISALLOWED,
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--setting-sources', '',
    ];

    const { lines, timedOut, spawnError, stderrTail } = await runClaude(args, timeoutMs);

    // Trajectory accounting from the stream: what was called, how much came back.
    const toolCalls = [];
    let toolResultChars = 0;
    let result = null;
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type === 'assistant') {
        for (const block of obj.message?.content ?? []) {
          if (block.type === 'tool_use') {
            toolCalls.push({ name: block.name, input: compactInput(block.input) });
          }
        }
      } else if (obj.type === 'user') {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') toolResultChars += JSON.stringify(block.content ?? '').length;
          }
        }
      } else if (obj.type === 'result') {
        result = obj;
      }
    }

    const logDir = path.join(repoRoot, 'eval', 'results', 'logs', runStamp);
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${slug(caseId)}.${this.arm}.${model}.jsonl`);
    fs.writeFileSync(logFile, lines.join('\n') + '\n');

    if (!result) {
      return {
        error: spawnError ?? (timedOut ? `claude run timed out after ${timeoutMs}ms` : `claude run produced no result envelope; stderr: ${stderrTail || '(empty)'}`),
        output: '',
        metadata: { arm: this.arm, toolCalls, toolResultChars, logFile, stderrTail },
      };
    }

    const u = result.usage ?? {};
    const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const summary = {
      arm: this.arm,
      caseId,
      model,
      costUsd: result.total_cost_usd ?? 0,
      tokensTotal: promptTokens + (u.output_tokens ?? 0),
      tokensUncached: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
      tokensCacheRead: u.cache_read_input_tokens ?? 0,
      tokensOutput: u.output_tokens ?? 0,
      numTurns: result.num_turns ?? 0,
      durationMs: result.duration_ms ?? 0,
      toolCallCount: toolCalls.length,
      toolResultChars,
      subtype: result.subtype,
      logFile: path.relative(repoRoot, logFile),
    };
    fs.appendFileSync(path.join(logDir, 'summary.jsonl'), JSON.stringify({ ...summary, toolCalls }) + '\n');

    // Budget/turn exhaustion is a legitimate benchmark outcome, not a harness error:
    // pass the (possibly empty) output through so the rubric grades it as a failure.
    return {
      output: result.result ?? '',
      tokenUsage: { total: summary.tokensTotal, prompt: promptTokens, completion: summary.tokensOutput, cached: summary.tokensCacheRead },
      cost: summary.costUsd,
      metadata: { ...summary, toolCalls },
    };
  }
}

function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: SANDBOX, env: process.env });
    let buf = '';
    let stderr = '';
    const lines = [];
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      spawnError = String(err);
      clearTimeout(timer);
      resolve({ lines, timedOut, spawnError, stderrTail: stderr.slice(-2000) });
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 100000) stderr = stderr.slice(-50000);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (buf.trim()) lines.push(buf);
      resolve({ lines, timedOut, spawnError, stderrTail: stderr.slice(-2000) });
    });
  });
}

// Keep the trajectory log readable: tool inputs matter (what was searched), but cap
// any single value so a pasted file doesn't bloat the summary.
function compactInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + `…[${v.length} chars]` : v;
  }
  return out;
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60);
}
