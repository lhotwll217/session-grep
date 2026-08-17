#!/usr/bin/env node
// session-grep — literal/regex grep across AI coding-session transcripts (Claude Code,
// Codex, Pi) returning bounded MESSAGE context around each hit, not raw JSONL lines.
// Ported from owner-operator's sessions-grep skill; standalone here so it can be shared
// and continuously eval-tuned (see eval/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configuredSourceOf, loadSessionSources } from './sources.mjs';

const args = process.argv.slice(2);
const opts = { limit: 20, before: 1, after: 1, role: 'all', source: 'all', sort: 'newest', json: false, regex: false, roots: [], excludeRe: [], maxChars: 8000 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--query') opts.query = args[++i];
  else if (a === '--limit') opts.limit = Number(args[++i]);
  else if (a === '--before') { opts.before = Number(args[++i]); opts.beforeSet = true; }
  else if (a === '--after') { opts.after = Number(args[++i]); opts.afterSet = true; }
  else if (a === '--role') opts.role = args[++i];
  else if (a === '--source') opts.source = args[++i];
  else if (a === '--since') opts.since = args[++i];
  else if (a === '--sort') opts.sort = args[++i];
  else if (a === '--root') opts.roots.push(args[++i]);
  else if (a === '--exclude-re') opts.excludeRe.push(args[++i]);
  else if (a === '--max-chars') { opts.maxChars = Number(args[++i]); opts.maxCharsSet = true; }
  else if (a === '--max-tokens') { opts.maxChars = Number(args[++i]) * 4; opts.maxCharsSet = true; }
  else if (a === '--overview') opts.overview = true;
  else if (a === '--skim') opts.skim = args[++i];
  else if (a === '--session') opts.session = args[++i];
  else if (a === '--at') opts.at = Number(args[++i]);
  else if (a === '--list-roots') opts.listRoots = true;
  else if (a === '--self-test') opts.selfTest = true;
  else if (a === '--include-tools') opts.includeTools = true;
  else if (a === '--any') opts.any = true;
  else if (a === '--regex') opts.regex = true;
  else if (a === '--case-sensitive') opts.caseSensitive = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--help' || a === '-h') usage(0);
  else usage(1, `Unknown arg: ${a}`);
}

// ─── FORMAT ADAPTERS ────────────────────────────────────────────────────────
// Loaded from the adapters/ folder next to this script — one file per session
// format, each exporting {name, detect(file), message(record, opts), fallback?}.
// Supporting a new JSONL-based tool = dropping one file in that folder (plus a
// --self-test fixture below). `--source` values and dispatch derive from what's
// loaded. Non-JSONL formats (Cursor's sqlite, opencode's split JSON) also need a
// reader change here; see SKILL.md "Onboarding" for the format map.
import { fileURLToPath, pathToFileURL } from 'node:url';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS = {};
{
  const dir = path.join(scriptDir, 'adapters');
  const loaded = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    if (mod.default?.name && mod.default.detect && mod.default.message) loaded.push(mod.default);
  }
  loaded.sort((a, b) => (a.fallback ? 1 : 0) - (b.fallback ? 1 : 0)); // fallbacks last
  for (const a of loaded) ADAPTERS[a.name] = a;
}
// ────────────────────────────────────────────────────────────────────────────

if (opts.selfTest) {
  process.exit(await selfTest());
}
if (opts.at != null && !opts.session) usage(1, '--at requires --session ID_PREFIX');
if (!opts.query && !opts.overview && !opts.skim && !opts.listRoots && !(opts.session && opts.at != null)) usage(1, 'Missing --query (or use --overview / --skim ID / --session ID --at INDEX)');
if (!Number.isFinite(opts.limit) || opts.limit < 1) usage(1, '--limit must be >= 1');
if (!Number.isFinite(opts.maxChars) || opts.maxChars < 500) usage(1, '--max-chars must be >= 500 (--max-tokens >= 125)');
if (!Number.isFinite(opts.before) || opts.before < 0) usage(1, '--before must be >= 0');
if (!Number.isFinite(opts.after) || opts.after < 0) usage(1, '--after must be >= 0');
if (!['all', 'user', 'assistant'].includes(opts.role)) usage(1, '--role must be all, user, or assistant');
if (opts.source !== 'all' && !ADAPTERS[opts.source]) usage(1, `--source must be all or one of: ${Object.keys(ADAPTERS).join(', ')}`);
if (!['newest', 'oldest', 'file'].includes(opts.sort)) usage(1, '--sort must be newest, oldest, or file');
const sinceTime = opts.since ? parseSince(opts.since) : null;
if (opts.since && sinceTime == null) usage(1, '--since must be today, Nd, or YYYY-MM-DD');
if (opts.any && opts.regex) usage(1, '--any and --regex cannot be combined');
const queryRegex = opts.regex ? compileRegex(opts.query, opts.caseSensitive) : null;

// --exclude-re: path-based exclusion, applied wherever session files are enumerated
// (search, browse, window mode) so an excluded transcript can never surface. This is
// the hook wrappers use to enforce a blacklist (e.g. owner-operator's privacy layer);
// patterns are JS regexes tested against the full file path.
const excludeRes = opts.excludeRe.map((p) => {
  if (typeof p !== 'string' || !p.length) usage(1, '--exclude-re requires a regex argument');
  try {
    return new RegExp(p);
  } catch (error) {
    usage(1, `--exclude-re: invalid JavaScript regex ${JSON.stringify(p)}: ${error.message}`);
  }
});
const isExcluded = (file) => excludeRes.some((re) => re.test(file));

// --any: multi-word phrases rarely occur verbatim in transcripts, so match ANY word
// and rank by how many distinct words a message hits. Low-signal words are dropped
// from the word set so common glue doesn't dominate the ranking.
const STOPWORDS = new Set(['the', 'and', 'was', 'were', 'did', 'does', 'you', 'your', 'why', 'how', 'what', 'when', 'where', 'which', 'who', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'are', 'not', 'but', 'about', 'into', 'out', 'our', 'they', 'them', 'then', 'than', 'its', 'get', 'got', 'can', 'could', 'would', 'should', 'ever', 'any', 'all', 'some', 'there']);
let anyWords = null;
if (opts.any) {
  const raw = opts.query.split(/\s+/).filter(Boolean);
  const strong = raw.filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  // Dedupe: repeated words must not double-count df or score.
  anyWords = [...new Set((strong.length ? strong : raw).map((w) => (opts.caseSensitive ? w : w.toLowerCase())))];
  if (!anyWords.length) usage(1, '--any needs at least one query word');
}

// Built-in default roots, searched when SESSION_GREP_SOURCES_FILE is unset. These are
// the standard per-user homes for each tool; roots that don't exist are skipped, so
// zero config works out of the box. To search a relocated store or a new tool: add an
// adapter in adapters/ and a line here (this file is yours to edit — the skill is
// vendored via `npx skills add`), or point SESSION_GREP_SOURCES_FILE at a JSON array of
// { type, root }, or pass --root DIR for one call. See SKILL.md "Onboarding".
const DEFAULT_SOURCES = [
  { type: 'claude', root: '~/.claude/projects' },
  { type: 'codex', root: '~/.codex/sessions' },
  { type: 'codex', root: '~/.codex/archived_sessions' },
  { type: 'pi', root: '~/.pi/agent/sessions' },
];
const sourceNames = Object.keys(ADAPTERS);
const sourceMap = loadSessionSources({
  knownSources: sourceNames,
  defaultSources: DEFAULT_SOURCES,
  rootOverrides: opts.roots,
});
const roots = sourceMap.roots.map((entry) => entry.root).filter((dir) => fs.existsSync(dir));
// A present-but-broken override silently reverts to defaults; say so on every run so a
// mistake in SESSION_GREP_SOURCES_FILE never passes as "no override took effect".
if (sourceMap.configError) {
  const why = { missing: 'does not exist', unparseable: 'is not valid JSON', 'not-an-array': 'must be a JSON array of { type, root }' }[sourceMap.configError] ?? 'could not be used';
  console.error(`session-grep: warning: SESSION_GREP_SOURCES_FILE ${sourceMap.configPath} ${why} — using built-in defaults (see --list-roots)`);
}
if (opts.listRoots) {
  console.log(`origin=${sourceMap.origin}`);
  console.log(`config=${sourceMap.configPath ?? '(none)'}`);
  if (sourceMap.configError) console.log(`config_error=true (${sourceMap.configError}; using built-in defaults)`);
  for (const entry of sourceMap.roots) console.log(`${entry.type}\texists=${fs.existsSync(entry.root)}\t${entry.root}`);
  process.exit(0);
}
if (!roots.length) usage(1, 'No session roots found to search — edit DEFAULT_SOURCES / set SESSION_GREP_SOURCES_FILE (see SKILL.md "Onboarding") or pass --root DIR');

// The output budget is denominated in BYTES (≈ 4 bytes per token): CJK, emoji, and
// code cost what they actually cost the caller's context, and every rendered line —
// header, word_hits, hint, omission notices — is charged, so output never exceeds it.
function bytes(s) {
  return Buffer.byteLength(s);
}

// Browse modes answer "which session?" and "what happened in it?" in one call each —
// whole-thread questions shouldn't cost 20 grep probes. A skim substitutes for many
// probe calls, so it gets a roomier default budget.
if (opts.skim && !opts.maxCharsSet) opts.maxChars = 16000;
if (opts.overview || opts.skim) {
  browse();
  process.exit(0);
}

// Window mode: consume a hit's pointer. Every search hit prints `id=... idx=...`;
// `--session ID --at IDX` returns the exact messages around that index — drill-in
// without re-running the search. Context defaults widen to ±5 here (that's the point).
if (opts.session && opts.at != null) {
  if (!Number.isFinite(opts.at) || opts.at < 0) usage(1, '--at must be a message index >= 0 (from a hit\'s idx= field)');
  const file = allSessionFiles().find((f) => sessionId(f).startsWith(opts.session));
  if (!file) usage(1, `No session file matching id prefix "${opts.session}" under: ${roots.join(', ')}`);
  const messages = parseMessages(fs.readFileSync(file, 'utf8'), sourceOf(file));
  if (opts.at >= messages.length) {
    usage(1, `--at ${opts.at} out of range: session ${sessionId(file)} has ${messages.length} messages (0..${messages.length - 1}). Note: indexes depend on --include-tools — drill in with the same setting the search used.`);
  }
  const b = opts.beforeSet ? opts.before : 5;
  const a = opts.afterSet ? opts.after : 5;
  const from = Math.max(0, opts.at - b);
  const to = Math.min(messages.length - 1, opts.at + a);
  const head = `window id=${sessionId(file)} messages ${from}..${to} of ${messages.length} path=${file}`;
  console.log(head);
  let size = bytes(head) + 1 + 64; // 64: reserve for the truncation notice
  for (let i = from; i <= to; i++) {
    const m = messages[i];
    const line = `[${i}]${i === opts.at ? '*' : ' '} ${m.role}${m.timestamp ? ' ' + String(m.timestamp).slice(0, 16) : ''}: ${truncate(m.text, i === opts.at ? 600 : 300)}`;
    if (size + bytes(line) + 1 > opts.maxChars) { console.log(`... window truncated by --max-chars at [${i}]`); break; }
    size += bytes(line) + 1;
    console.log(line);
  }
  process.exit(0);
}

const rg = spawnSync('rg', [
  ...(opts.caseSensitive ? [] : ['-i']),
  ...(opts.regex ? [] : ['--fixed-strings']),
  '--files-with-matches',
  '--glob',
  '*.jsonl',
  ...(anyWords ? anyWords.flatMap((w) => ['-e', w]) : [opts.query]),
  ...roots,
], { encoding: 'utf8' });

if (rg.error) {
  usage(1, `ripgrep (rg) is required but could not be run (${rg.error.code ?? rg.error.message}). Install it, e.g. \`brew install ripgrep\`.`);
}
let files;
if (rg.status === 2 && opts.regex) {
  // A JS-valid regex that ripgrep's engine rejects (lookaround, backrefs) must not
  // die at the prefilter — fall back to scanning every session file with the JS matcher.
  files = allSessionFiles();
} else if (rg.status === 2) {
  const detail = rg.stderr.trim() ? `\n${rg.stderr.trim()}` : '';
  usage(1, `Invalid query for ripgrep.${detail}`);
} else {
  files = rg.status === 0 ? rg.stdout.trim().split('\n').filter(Boolean) : [];
}
files = files.filter((f) => !isExcluded(f));
const matches = [];
const q = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
// --any rarity stats: document frequency per word across scanned messages. Rare words
// are the signal; the ranking weights them (IDF) and the output reports the counts so
// the caller learns which of its words are low-signal. Counted AFTER the --role/--since
// filters so word_hits describes the population the caller actually sees.
const wordDf = anyWords ? Object.fromEntries(anyWords.map((w) => [w, 0])) : null;
let messagesScanned = 0;

for (const file of files) {
  const source = sourceOf(file);
  if (opts.source !== 'all' && source !== opts.source) continue;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const messages = parseMessages(raw, source);
  let fileMtime = null; // timestamp fallback, one stat per file not per message
  const mtime = () => (fileMtime ??= fs.statSync(file).mtimeMs);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (opts.role !== 'all' && msg.role !== opts.role) continue;
    let time = null;
    if (sinceTime != null) {
      time = timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? mtime();
      if (time < sinceTime) continue;
    }
    messagesScanned++;
    const haystack = opts.caseSensitive ? msg.text : msg.text.toLowerCase();
    let hitWords = null;
    if (anyWords) {
      hitWords = anyWords.filter((w) => haystack.includes(w));
      for (const w of hitWords) wordDf[w]++;
      if (!hitWords.length) continue;
    } else if (opts.regex ? !queryRegex.test(msg.text) : !haystack.includes(q)) continue;
    time ??= timeOf(msg.timestamp) ?? timeOf(messages[0]?.timestamp) ?? mtime();
    matches.push({
      source,
      id: sessionId(file),
      path: file,
      index: i,
      timestamp: msg.timestamp,
      time,
      ...(anyWords ? { matchedWords: hitWords } : {}),
      before: messages.slice(Math.max(0, i - opts.before), i),
      match: msg,
      after: messages.slice(i + 1, i + 1 + opts.after),
    });
  }
}

// With --any, rank by summed word rarity (IDF): a hit on one rare identifier beats a
// hit on three ubiquitous words. Recency breaks ties.
if (anyWords) {
  const idf = (w) => Math.log((messagesScanned + 1) / (wordDf[w] + 1));
  for (const m of matches) m.score = round3(m.matchedWords.reduce((t, w) => t + idf(w), 0));
  matches.sort((a, b) => b.score - a.score || (opts.sort === 'oldest' ? a.time - b.time : b.time - a.time));
} else if (opts.sort === 'newest') matches.sort((a, b) => b.time - a.time);
else if (opts.sort === 'oldest') matches.sort((a, b) => a.time - b.time);
const limited = matches.slice(0, opts.limit);

// Zero hits should steer the next query, not dead-end the agent: multi-word literal
// phrases almost never occur verbatim in transcripts — say so and point at --any.
const hint = !limited.length
  ? (!opts.any && opts.query.trim().split(/\s+/).length > 1 && !opts.regex
      ? 'no hits: multi-word phrases rarely occur verbatim in transcripts — retry with --any (matches any word, ranked by words matched), or grep ONE rare term (an identifier, error string, or filename)'
      : opts.any
        ? 'no hits for any query word: try different, rarer words (identifiers, error strings, filenames), or loosen --since/--role filters'
        : 'no hits: try a rarer single term, or --any with several candidate words')
  : null;

// Per-word hit counts teach the caller which of its words are low-signal: a word
// matching thousands of messages contributes nothing — drop it next query.
const wordStats = anyWords
  ? anyWords.map((w) => `${w}=${wordDf[w]}`).join(' ')
  : null;

// Output is budgeted (--max-chars bytes, default 8k): a bad query can't flood the
// caller's context. The REAL header, word_hits, hint, and omission lines are charged
// against the budget (not a fixed allowance), then hits are selected in rank order.
// Evidence outranks metadata: before returning zero hits, the word_hits table is
// dropped and the top match hard-truncated — shown=0 with matches>0 must not happen
// because a df table spent the whole aperture.
const OMIT = (n) => `... ${n} more matching messages omitted by the ${opts.maxChars}-byte output budget — narrow with --role/--since${opts.any ? '/rarer words' : ''}, or raise --max-chars`;
const queryEcho = truncate(opts.query, 120); // a 2k-char query must not eat the budget echoing itself

function selectWithinBudget(renderLen, trimContext, budget) {
  const emitted = [];
  let size = 0;
  for (const m of limited) {
    let entry = m;
    let len = renderLen(entry);
    if (size + len > budget) {
      entry = trimContext(entry); // shed context before dropping a hit (fills tail space too)
      len = renderLen(entry);
      if (size + len > budget) break;
    }
    size += len;
    emitted.push(entry);
  }
  return emitted;
}

// Shared last-resort pass: no context, match text shrunk until the entry fits.
function forceOneHit(renderLen, budget) {
  const m = limited[0];
  for (let room = 300; room >= 40; room = Math.floor(room / 2)) {
    const cand = { ...m, before: [], after: [], match: { ...m.match, text: truncate(m.match.text, room) } };
    if (renderLen(cand) <= budget) return [cand];
  }
  return [];
}

if (opts.json) {
  const slim = (msg) => ({ role: msg.role, text: truncate(msg.text, 300), timestamp: msg.timestamp });
  const toEntry = (m) => ({ source: m.source, id: m.id, index: m.index, timestamp: m.timestamp, ...(anyWords ? { matchedWords: m.matchedWords, score: m.score } : {}), path: m.path, before: m.before.map(slim), match: slim(m.match), after: m.after.map(slim) });
  const entryLen = (m) => bytes(JSON.stringify(toEntry(m))) + 1;
  let withStats = !!anyWords;
  // Worst-case envelope (max shown/omitted digits, omission note included) so the
  // real output can only come in at or under the charged size.
  const envelope = (matchesArr, shown, omitted) => ({ query: queryEcho, regex: opts.regex, any: !!opts.any, ...(withStats ? { wordHits: wordDf, messagesScanned } : {}), rawFilesWithHits: files.length, totalMatches: matches.length, shown, ...(omitted ? { omittedByBudget: omitted, note: OMIT(omitted) } : {}), ...(hint ? { hint } : {}), matches: matchesArr });
  const room = () => opts.maxChars - bytes(JSON.stringify(envelope([], limited.length, limited.length)));
  let emitted = selectWithinBudget(entryLen, (m) => ({ ...m, before: [], after: [] }), room());
  if (!emitted.length && limited.length && withStats) {
    withStats = false;
    emitted = selectWithinBudget(entryLen, (m) => ({ ...m, before: [], after: [] }), room());
  }
  if (!emitted.length && limited.length) emitted = forceOneHit(entryLen, room());
  console.log(JSON.stringify(envelope(emitted.map(toEntry), emitted.length, limited.length - emitted.length)));
} else {
  const renderLines = (m) => [
    `${m.source} id=${m.id} idx=${m.index} ts=${m.timestamp ?? ''}${anyWords ? ` matched=[${m.matchedWords.join(',')}] score=${m.score}` : ''}`,
    `path=${m.path}`,
    ...m.before.map((b) => `  before ${b.role}: ${truncate(b.text, 180)}`),
    `  MATCH ${m.match.role}: ${truncate(m.match.text, 300)}`,
    ...m.after.map((a) => `  after  ${a.role}: ${truncate(a.text, 180)}`),
  ];
  const entryLen = (m) => renderLines(m).reduce((t, l) => t + bytes(l) + 1, 6);
  const header = (shown) => `query=${JSON.stringify(queryEcho)}${opts.regex ? ' regex=true' : ''}${opts.any ? ` any=true` : ''} raw_files_with_hits=${files.length} total_message_matches=${matches.length} shown=${shown} sort=${opts.sort}${opts.since ? ` since=${opts.since}` : ''}${opts.caseSensitive ? ' case_sensitive=true' : ''}`;
  let wordStatsLine = wordStats ? `word_hits: ${truncate(wordStats, 300)} (of ${messagesScanned} messages searched after filters; high-count words are low-signal — prefer the rare ones)` : null;
  const hintLine = hint ? `hint: ${hint}` : null;
  const room = () => opts.maxChars
    - bytes(header(limited.length)) - 1
    - (wordStatsLine ? bytes(wordStatsLine) + 1 : 0)
    - (hintLine ? bytes(hintLine) + 1 : 0)
    - (limited.length ? bytes(OMIT(limited.length)) + 2 : 0);
  let emitted = selectWithinBudget(entryLen, (m) => ({ ...m, before: [], after: [] }), room());
  if (!emitted.length && limited.length && wordStatsLine) {
    wordStatsLine = null;
    emitted = selectWithinBudget(entryLen, (m) => ({ ...m, before: [], after: [] }), room());
  }
  if (!emitted.length && limited.length) emitted = forceOneHit(entryLen, room());
  const omitted = limited.length - emitted.length;
  console.log(header(emitted.length));
  if (wordStatsLine) console.log(wordStatsLine);
  if (hintLine) console.log(hintLine);
  emitted.forEach((m, idx) => {
    const [head, ...rest] = renderLines(m);
    console.log(`\n[${idx + 1}] ${head}`);
    for (const l of rest) console.log(l);
  });
  if (omitted) console.log(`\n${OMIT(omitted)}`);
}

function sourceOf(file) {
  const configured = configuredSourceOf(file, sourceMap, sourceNames);
  if (configured) return configured;
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.detect(file)) return name;
  }
}

function parseMessages(raw, source) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = ADAPTERS[source].message(obj, { includeTools: opts.includeTools });
    if (!msg || !msg.text.trim()) continue;
    out.push(msg);
  }
  return out;
}

function sessionId(file) {
  return path.basename(file, '.jsonl');
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function allSessionFiles() {
  const out = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { recursive: true })) {
      const p = path.join(root, String(entry));
      if (p.endsWith('.jsonl') && !isExcluded(p) && fs.statSync(p).isFile()) out.push(p);
    }
  }
  return out;
}

// --overview: one compact digest per session (id, dates, message counts, opening user
// prompt) so the caller can pick the right session in a single cheap call.
// --skim ID: the conversational spine of one session — user + assistant text only,
// head/tail preserved and the middle sampled evenly to fit the output budget. Indexes
// are printed so specifics can be drilled with a targeted --query afterwards.
function browse() {
  const files = allSessionFiles().filter((file) => opts.source === 'all' || sourceOf(file) === opts.source);
  if (opts.skim) {
    const file = files.find((f) => sessionId(f).startsWith(opts.skim));
    if (!file) usage(1, `No session file matching id prefix "${opts.skim}" under: ${roots.join(', ')}`);
    const messages = parseMessages(fs.readFileSync(file, 'utf8'), sourceOf(file));
    const lines = messages.map((m, i) => `[${i}] ${m.role}${m.timestamp ? ' ' + String(m.timestamp).slice(0, 16) : ''}: ${truncate(m.text, 200)}`);
    const head0 = `skim id=${sessionId(file)} messages=${messages.length} path=${file}`;
    console.log(head0);
    const available = opts.maxChars - bytes(head0) - 2; // hard byte ceiling for everything below the header
    const sizeOf = (ls) => ls.reduce((t, l) => t + bytes(l) + 1, 0);
    if (sizeOf(lines) <= available) {
      for (const l of lines) console.log(l);
      return;
    }
    const avg = sizeOf(lines) / lines.length;
    // Budget is authoritative — no minimum floor (codex review: keep>=20 blew small
    // budgets). Head/tail sizes scale down with the budget; middle picks are CENTERED
    // in their strides so low sample counts don't cluster at the start of the middle.
    // The average only ESTIMATES the sample count; the assembled output (sampled-out
    // notices included) is then measured in bytes and middle picks dropped until it
    // fits, so head and tail always survive and the ceiling always holds.
    const keep = Math.max(3, Math.floor(available / avg));
    const edge = Math.min(10, Math.floor(keep / 3), Math.floor(lines.length / 2));
    const head = Math.max(1, edge);
    const tail = Math.min(Math.max(1, edge), lines.length - head);
    const middleKeep = Math.max(0, keep - head - tail);
    const middle = lines.length - head - tail;
    const stride = middleKeep > 0 ? middle / middleKeep : Infinity;
    let picks = [];
    for (let i = 0; i < middleKeep; i++) picks.push(head + Math.min(middle - 1, Math.floor((i + 0.5) * stride)));
    const assemble = (midPicks) => {
      const chosen = new Set(midPicks);
      for (let i = 0; i < head; i++) chosen.add(i);
      for (let i = lines.length - tail; i < lines.length; i++) chosen.add(i);
      const out = [];
      let skipped = 0;
      for (let i = 0; i < lines.length; i++) {
        if (chosen.has(i)) {
          if (skipped) out.push(`  ... ${skipped} messages sampled out (drill in with --query on anything above/below) ...`);
          skipped = 0;
          out.push(lines[i]);
        } else {
          skipped++;
        }
      }
      if (skipped) out.push(`  ... ${skipped} messages sampled out ...`);
      return out;
    };
    let out = assemble(picks);
    while (sizeOf(out) > available && picks.length) {
      picks = picks.slice(0, -1);
      out = assemble(picks);
    }
    // Degenerate floor (tiny budget, long lines): opening message + omission notice.
    if (sizeOf(out) > available) out = [lines[0], `  ... ${lines.length - 1} more messages omitted by --max-chars ...`];
    for (const l of out) console.log(l);
    return;
  }

  // --overview
  const digests = [];
  for (const file of files) {
    const source = sourceOf(file);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const messages = parseMessages(raw, source);
    if (!messages.length) continue;
    const first = messages.find((m) => m.role === 'user') ?? messages[0];
    const times = messages.map((m) => timeOf(m.timestamp)).filter((t) => t != null);
    const lastTime = times.length ? Math.max(...times) : fs.statSync(file).mtimeMs;
    if (sinceTime != null && lastTime < sinceTime) continue;
    digests.push({
      id: sessionId(file),
      source,
      path: file,
      from: times.length ? new Date(Math.min(...times)).toISOString().slice(0, 16) : '?',
      to: times.length ? new Date(Math.max(...times)).toISOString().slice(0, 16) : '?',
      user: messages.filter((m) => m.role === 'user').length,
      assistant: messages.filter((m) => m.role === 'assistant').length,
      mb: (raw.length / 1e6).toFixed(1),
      opening: truncate(first.text, 220),
      lastTime,
    });
  }
  digests.sort((a, b) => b.lastTime - a.lastTime);
  const head0 = `sessions=${digests.length} (newest first) — drill in with --skim ID or --query`;
  console.log(head0);
  let size = bytes(head0) + 1 + 64; // 64: reserve for the omission notice
  for (const d of digests) {
    const block = `\nid=${d.id} source=${d.source} ${d.from} -> ${d.to} msgs=${d.user}u/${d.assistant}a size=${d.mb}MB\n  opening: ${d.opening}`;
    if (size + bytes(block) + 1 > opts.maxChars) {
      console.log(`\n... remaining sessions omitted by --max-chars budget`);
      break;
    }
    size += bytes(block) + 1;
    console.log(block);
  }
}

// Byte-budgeted truncation (n is bytes, ≈ chars for ASCII). Never splits a surrogate
// pair, so CJK/emoji previews stay valid text and cost what they claim.
function truncate(s, n) {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(oneLine) <= n) return oneLine;
  let end = Math.min(oneLine.length, n);
  while (end > 0 && Buffer.byteLength(oneLine.slice(0, end)) > n - 3) end--;
  let cut = oneLine.slice(0, end);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}...`;
}

function timeOf(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function parseSince(value) {
  const now = new Date();
  if (value === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = value.match(/^(\d+)d$/);
  if (days) return now.getTime() - Number(days[1]) * 24 * 60 * 60 * 1000;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00`);
  return null;
}

function compileRegex(pattern, caseSensitive) {
  try {
    return new RegExp(pattern, caseSensitive ? 'u' : 'iu');
  } catch (error) {
    usage(1, `Invalid JavaScript regex: ${error.message}`);
  }
}

function usage(code, msg) {
  if (msg) console.error(msg);
  console.error('Usage: session-grep.mjs --query TEXT [--any] [--regex] [--limit N] [--before N] [--after N] [--role user|assistant|all] [--source claude|codex|pi|all] [--since today|Nd|YYYY-MM-DD] [--sort newest|oldest|file] [--root DIR ...] [--exclude-re REGEX ...] [--max-chars BYTES | --max-tokens N] [--include-tools] [--case-sensitive] [--json] | --overview | --skim ID | --session ID --at INDEX | --list-roots | --self-test');
  process.exit(code);
}

// ── self-test ───────────────────────────────────────────────────────────────
// The skill carries its own verification: builds a synthetic corpus in a temp dir,
// runs this script against it, and asserts every advertised behavior. Zero deps —
// works wherever the skill is copied. `node session-grep.mjs --self-test`
async function selfTest() {
  const { execFileSync } = await import('node:child_process');
  const self = process.argv[1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-grep-selftest-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const line = (role, content, ts) => JSON.stringify({ type: role, timestamp: ts, message: { role, content } }) + '\n';
  const text = (t) => [{ type: 'text', text: t }];

  // Session A: 30 messages; a rare identifier late; a tool_result echo; common words everywhere.
  let a = '';
  for (let i = 0; i < 12; i++) a += line(i % 2 ? 'assistant' : 'user', text(`common sidebar chatter number ${i} about the project`), `2026-06-01T10:${String(i).padStart(2, '0')}:00Z`);
  a += line('assistant', text('the flumoxide bug came from spawnSync returning ENOENT'), '2026-06-01T10:20:00Z');
  a += line('user', [{ type: 'tool_result', content: 'TOOLNOISE flumoxide echoed inside tool output ZEBRAECHO' }], '2026-06-01T10:21:00Z');
  for (let i = 0; i < 12; i++) a += line(i % 2 ? 'assistant' : 'user', text(`more sidebar discussion segment ${i} winding down`), `2026-06-01T11:${String(i).padStart(2, '0')}:00Z`);
  a += line('user', text('final closing message of session alpha'), '2026-06-01T12:00:00Z');
  fs.writeFileSync(path.join(proj, 'aaaa1111.jsonl'), a);
  // Session CJK: Japanese text — exercises byte (not UTF-16) budget accounting.
  let cj = '';
  for (let i = 0; i < 20; i++) cj += line(i % 2 ? 'assistant' : 'user', text(`現地時間のバグについての議論 その${i} — タイムゾーン変換が失敗する`), `2026-06-03T10:${String(i).padStart(2, '0')}:00Z`);
  fs.writeFileSync(path.join(proj, 'cjkcjk11.jsonl'), cj);
  // Session B: small, distinct.
  fs.writeFileSync(path.join(proj, 'bbbb2222.jsonl'),
    line('user', text('opening question about quixotic deployment'), '2026-06-05T09:00:00Z') +
    line('assistant', text('quixotic deployment answered with lookahead syntax note'), '2026-06-05T09:01:00Z'));
  // Session C: codex format (exercises the adapter registry + path detection).
  fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
  const codexLine = (role, t, ts) => JSON.stringify({ type: 'response_item', timestamp: ts, payload: { type: 'message', role, content: [{ type: 'output_text', text: t }] } }) + '\n';
  fs.writeFileSync(path.join(dir, 'codex', 'rollout-cccc.jsonl'),
    codexLine('assistant', 'zorptastic reply straight from the codex adapter', '2026-06-07T08:00:00Z'));
  // Same Codex format under a root whose path does not reveal the format. This
  // exercises the SESSION_GREP_SOURCES_FILE override as the source of truth for parsing.
  fs.mkdirSync(path.join(dir, 'relocated'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'relocated', 'rollout-dddd.jsonl'),
    codexLine('assistant', 'relocatedsource reply from a configured codex root', '2026-06-08T08:00:00Z'));
  fs.mkdirSync(path.join(dir, 'moved'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'moved', 'eeee2222.jsonl'),
    line('assistant', text('movedclaude reply from a configured claude root'), '2026-06-09T08:00:00Z'));
  // Session E: pi format (session header + tree-structured message entries; tool output
  // is its own role:"toolResult" message). Path contains /pi/ to exercise detection.
  fs.mkdirSync(path.join(dir, 'pi'), { recursive: true });
  const piLine = (role, content, ts) => JSON.stringify({ type: 'message', id: 'ab12cd34', parentId: null, timestamp: ts, message: { role, content } }) + '\n';
  fs.writeFileSync(path.join(dir, 'pi', '2026-06-10T08-00-00_ffff3333.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 'ffff3333', timestamp: '2026-06-10T08:00:00Z', cwd: '/tmp/proj' }) + '\n' +
    piLine('user', 'plumbuscal question asked in the pi harness', '2026-06-10T08:00:01Z') +
    piLine('assistant', [{ type: 'text', text: 'plumbuscal answered straight from the pi adapter' }], '2026-06-10T08:00:02Z') +
    JSON.stringify({ type: 'message', id: 'ef56ab78', parentId: 'ab12cd34', timestamp: '2026-06-10T08:00:03Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'PINOISE tool output from pi' }], isError: false } }) + '\n' +
    piLine('custom', [{ type: 'text', text: 'PICUSTOM non-conversation entry' }], '2026-06-10T08:00:04Z'));
  // Same pi format under a root whose path does not reveal the format (config routing).
  fs.mkdirSync(path.join(dir, 'relocated-pi'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'relocated-pi', '2026-06-11T08-00-00_gggg4444.jsonl'),
    piLine('assistant', [{ type: 'text', text: 'relocatedpi reply from a configured pi root' }], '2026-06-11T08:00:00Z'));

  const runRaw = (args, env = {}) => execFileSync(process.execPath, [self, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const run = (args) => runRaw([...args, '--root', dir]);
  let n = 0;
  const failures = [];
  const check = (name, cond) => { n++; if (!cond) failures.push(name); };

  try {
    // literal + context + truthful shown count
    const lit = JSON.parse(run(['--query', 'flumoxide', '--json']));
    check('literal finds text block', lit.matches.some((m) => m.match.text.includes('spawnSync')));
    check('shown equals matches length', lit.shown === lit.matches.length);
    check('tool_result excluded by default', !lit.matches.some((m) => m.match.text.includes('TOOLNOISE')));
    const withTools = JSON.parse(run(['--query', 'ZEBRAECHO', '--json', '--include-tools']));
    check('--include-tools matches tool output', withTools.totalMatches === 1);
    const withoutTools = JSON.parse(run(['--query', 'ZEBRAECHO', '--json']));
    check('tool-only needle invisible by default', withoutTools.totalMatches === 0);

    // --any: rarity ranking + dedupe
    const any = JSON.parse(run(['--query', 'sidebar flumoxide sidebar', '--any', '--json']));
    check('any dedupes words', Object.keys(any.wordHits).length === 2);
    check('rare word ranks first', any.matches[0].matchedWords.includes('flumoxide'));
    check('word df counted', any.wordHits.sidebar > any.wordHits.flumoxide);

    // budget enforcement: the budget is a hard byte ceiling, all lines charged
    const tiny = run(['--query', 'sidebar', '--limit', '30', '--max-chars', '600']);
    check('budget is a hard byte ceiling', Buffer.byteLength(tiny) <= 600);
    check('omission notice present', tiny.includes('omitted by the 600-byte output budget'));
    const tinyShown = Number(tiny.match(/shown=(\d+)/)[1]);
    check('header shown = emitted blocks', (tiny.match(/\n\[\d+\]/g) || []).length === tinyShown);
    const tokens = run(['--query', 'sidebar', '--limit', '30', '--max-tokens', '200']);
    check('--max-tokens = 4 bytes per token', Buffer.byteLength(tokens) <= 800);
    const tinyJson = run(['--query', 'sidebar', '--limit', '30', '--max-chars', '600', '--json']);
    check('json budget is a hard byte ceiling', Buffer.byteLength(tinyJson) <= 600);
    check('json still parses under budget pressure', JSON.parse(tinyJson).shown >= 1);
    // evidence outranks metadata: common --any words + small budget must still show a hit
    const crowded = run(['--query', 'sidebar discussion chatter project segment', '--any', '--limit', '30', '--max-chars', '800']);
    check('crowded budget still shows evidence', Number(crowded.match(/shown=(\d+)/)[1]) >= 1);
    check('crowded budget stays under ceiling', Buffer.byteLength(crowded) <= 800);
    // a huge query must not blow the budget echoing itself in the header
    const longQ = run(['--query', 'z'.repeat(1500), '--max-chars', '500']);
    check('long query echo truncated', Buffer.byteLength(longQ) <= 500);
    // non-ASCII: bytes, not UTF-16 units — CJK output must respect the same ceiling
    const cjk = run(['--query', '現地時間', '--limit', '30', '--max-chars', '600']);
    check('cjk query finds hits', Number(cjk.match(/shown=(\d+)/)[1]) >= 1);
    check('cjk budget is a hard byte ceiling', Buffer.byteLength(cjk) <= 600);
    const cjkSkim = run(['--skim', 'cjkcjk11', '--max-chars', '900']);
    check('cjk skim within byte budget', Buffer.byteLength(cjkSkim) <= 900);
    // word_hits describes the population after --role/--since filters
    const dfAll = JSON.parse(run(['--query', 'sidebar flumoxide', '--any', '--json']));
    const dfUser = JSON.parse(run(['--query', 'sidebar flumoxide', '--any', '--role', 'user', '--json']));
    check('word df counted after filters', dfUser.wordHits.sidebar < dfAll.wordHits.sidebar);

    // zero-hit hint
    const miss = run(['--query', 'totally absent phrase here']);
    check('multi-word miss hints --any', miss.includes('retry with --any'));

    // regex incl. JS-only syntax (lookahead) falling back past rg
    const la = JSON.parse(run(['--regex', '--query', 'quixotic(?= deployment)', '--json']));
    check('JS-only regex still matches via fallback', la.totalMatches === 2);

    // overview + spine
    const ov = run(['--overview']);
    check('overview lists both sessions', ov.includes('aaaa1111') && ov.includes('bbbb2222'));
    const ovCodex = run(['--overview', '--source', 'codex']);
    check('overview honors --source', ovCodex.includes('rollout-cccc') && !ovCodex.includes('aaaa1111') && !ovCodex.includes('bbbb2222'));
    const ovRecent = run(['--overview', '--since', '2026-06-06']);
    check('overview honors --since', ovRecent.includes('rollout-cccc') && !ovRecent.includes('aaaa1111') && !ovRecent.includes('bbbb2222'));
    const spine = run(['--skim', 'aaaa1111', '--max-chars', '900']);
    check('skim within byte budget', Buffer.byteLength(spine) <= 900);
    check('skim keeps head', spine.includes('number 0'));
    check('skim keeps tail', spine.includes('session alpha'));

    // role filter still works
    const role = JSON.parse(run(['--query', 'sidebar', '--role', 'user', '--json']));
    check('role filter', role.matches.every((m) => m.match.role === 'user'));

    // adapter registry: codex format parsed, source detected from path, --source filters
    const cx = JSON.parse(run(['--query', 'zorptastic', '--json']));
    check('codex adapter parses', cx.totalMatches === 1 && cx.matches[0].source === 'codex');
    const cxOnly = JSON.parse(run(['--query', 'zorptastic', '--source', 'claude', '--json']));
    check('--source filters by adapter', cxOnly.totalMatches === 0);

    // pi adapter: format parsed, source detected from path, toolResult gated by --include-tools
    const pi = JSON.parse(run(['--query', 'plumbuscal', '--json']));
    check('pi adapter parses user+assistant', pi.totalMatches === 2 && pi.matches.every((m) => m.source === 'pi'));
    const piOnly = JSON.parse(run(['--query', 'zorptastic', '--source', 'pi', '--json']));
    check('--source pi filters by adapter', piOnly.totalMatches === 0);
    const piNoise = JSON.parse(run(['--query', 'PINOISE', '--json']));
    check('pi toolResult excluded by default', piNoise.totalMatches === 0);
    const piTools = JSON.parse(run(['--query', 'PINOISE', '--json', '--include-tools']));
    check('pi toolResult matches with --include-tools', piTools.totalMatches === 1 && piTools.matches[0].match.role === 'user');
    const piCustom = JSON.parse(run(['--query', 'PICUSTOM', '--json', '--include-tools']));
    check('pi non-conversation roles skipped', piCustom.totalMatches === 0);

    // --exclude-re: path-based exclusion holds across search, browse, and window modes
    const excluded = JSON.parse(run(['--query', 'sidebar', '--json', '--exclude-re', 'aaaa1111']));
    check('--exclude-re removes matching paths', excluded.totalMatches === 0);
    const kept = JSON.parse(run(['--query', 'quixotic', '--json', '--exclude-re', 'aaaa1111']));
    check('--exclude-re keeps non-matching paths', kept.totalMatches === 2);
    const ovExcluded = run(['--overview', '--exclude-re', 'aaaa1111', '--exclude-re', 'bbbb2222']);
    check('--exclude-re repeatable + honored by --overview', !ovExcluded.includes('aaaa1111') && !ovExcluded.includes('bbbb2222') && ovExcluded.includes('rollout-cccc'));
    const winExcluded = spawnSync(process.execPath, [self, '--session', 'aaaa1111', '--at', '0', '--root', dir, '--exclude-re', 'aaaa1111'], { encoding: 'utf8' });
    check('--exclude-re honored by --session/--at', winExcluded.status === 1 && !winExcluded.stdout.includes('flumoxide'));
    const badRe = spawnSync(process.execPath, [self, '--query', 'x', '--root', dir, '--exclude-re', '('], { encoding: 'utf8' });
    check('invalid --exclude-re rejected', badRe.status === 1 && badRe.stderr.includes('--exclude-re'));

    const sourcesFile = path.join(dir, 'session_sources.json');
    fs.writeFileSync(sourcesFile, JSON.stringify([
      { type: 'codex', root: path.join(dir, 'relocated') },
      { type: 'claude', root: path.join(dir, 'moved') },
      { type: 'pi', root: path.join(dir, 'relocated-pi') },
    ]));
    const configured = JSON.parse(runRaw(['--query', 'relocatedsource', '--json'], { SESSION_GREP_SOURCES_FILE: sourcesFile }));
    check('session_sources type routes codex parser', configured.totalMatches === 1 && configured.matches[0].source === 'codex');
    const configuredClaude = JSON.parse(runRaw(['--query', 'movedclaude', '--json'], { SESSION_GREP_SOURCES_FILE: sourcesFile }));
    check('session_sources type routes claude parser', configuredClaude.totalMatches === 1 && configuredClaude.matches[0].source === 'claude');
    const configuredPi = JSON.parse(runRaw(['--query', 'relocatedpi', '--json'], { SESSION_GREP_SOURCES_FILE: sourcesFile }));
    check('session_sources type routes pi parser', configuredPi.totalMatches === 1 && configuredPi.matches[0].source === 'pi');
    const listed = runRaw(['--list-roots'], { SESSION_GREP_SOURCES_FILE: sourcesFile });
    check('--list-roots shows configured root', listed.includes(`config=${sourcesFile}`) && listed.includes(path.join(dir, 'relocated')));
    // A malformed local config must be flagged, not silently swapped for the defaults.
    const badFile = path.join(dir, 'bad_sources.json');
    fs.writeFileSync(badFile, '{ "disable": ["codex"], not-valid ]');
    const bad = spawnSync(process.execPath, [self, '--list-roots'], { encoding: 'utf8', env: { ...process.env, SESSION_GREP_SOURCES_FILE: badFile } });
    check('malformed config warns on stderr', bad.stderr.includes('is not valid JSON'));
    check('malformed config flagged in --list-roots', bad.stdout.includes('config_error=true'));

    // pointer drill-in: consume a hit's id+idx via --session/--at
    const hit = JSON.parse(run(['--query', 'flumoxide', '--json'])).matches[0];
    const win = run(['--session', hit.id.slice(0, 6), '--at', String(hit.index)]);
    check('window centers on the hit', win.includes(`[${hit.index}]*`) && win.includes('flumoxide'));
    check('window includes neighbors', win.includes(`[${hit.index - 1}] `) && win.includes(`[${hit.index + 1}] `));
  } catch (error) {
    failures.push(`crashed: ${error.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`self-test: ${failures.length}/${n} FAILED:\n  - ${failures.join('\n  - ')}`);
    return 1;
  }
  console.log(`self-test: ok — ${n} assertions passed`);
  return 0;
}
