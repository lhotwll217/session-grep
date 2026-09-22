---
name: session-grep
description: >-
  Find content and sessions in local AI session transcripts (Claude Code, Codex, Pi): ranked any-word search, literal or regex grep, per-session overviews and skims, all with a bounded output budget and drill-in pointers. Use when the user asks what was said, decided, or done in a past session, wants to locate which session something happened in, or wants exact text or a pattern with the messages around it.
---

# session-grep

Searches local AI CLI session files and returns bounded message context with a stable
pointer per hit. Reasoning traces (Claude `thinking`, Codex `agent_reasoning`) are
conversation text and always searched; tool output and injected skill bodies are
excluded by default, and the result says when a match hid behind that exclusion.

## How to use

The script lives NEXT TO THIS FILE (in the repo: `skills/session-grep/session-grep.mjs`;
as an installed skill it sits in this skill's directory). Invoke it by its path relative
to this SKILL.md, shown below as `session-grep.mjs`. First run on a machine, or roots that
look wrong: read [ONBOARDING.md](ONBOARDING.md).

```bash
node session-grep.mjs --query "sidebar poll triage membership" --any --candidates --since 7d
node session-grep.mjs --query "sidebar poll triage membership" --any --candidates --rerank jev --limit 10
node session-grep.mjs --query "why did you" --since 7d --before 2 --after 2
node session-grep.mjs --query "checkpoint" --session 269a
node session-grep.mjs --session 269a --at 41
node session-grep.mjs --overview
node session-grep.mjs --skim 269a --max-chars 12000
node session-grep.mjs --regex --query "#[A-Za-z0-9_][A-Za-z0-9_-]*" --since 7d
```

Use exactly one primary mode per invocation: `--query`, `--overview`, `--skim`,
`--session ... --at ...`, or `--list-roots`. A query may add `--session ID` as a scope;
ambiguous combinations fail closed.

## Answering a question

1. **Scope by recency.** Recency is the default relevance heuristic: start with
   `--since 7d` (or the window the ask names; `--until` closes it) and widen only when
   the result is thin. A window also makes the search cheaper: files last written before
   `--since` are never read.
2. **Find.** `--any` with two to five rare words (identifiers, error strings, filenames),
   plus `--candidates` when the session is unknown. Use plain `--query` for exact text or
   punctuation and `--regex` for patterns. Multi-word literal phrases almost never occur
   verbatim; the header says so (`literal_multiword=true`) and the `--any` retry is the
   fix.
3. **Read the header before the hits, and act on it.**
   - `literal_multiword=true` → rerun with `--any`.
   - `tools_excluded=N` or `skill_excluded=N` → the match is behind a default exclusion;
     rerun with `--include-tools` or `--include-skill-bodies`. Reported on thin results
     only (fewer hits than `--limit`); `total_message_matches` counts visible hits.
   - `word_hits` with a high-count word → that word carries no signal; drop it.
   - `N more matching messages omitted by the budget` → narrow first (`--session`,
     `--role assistant`, `--since`, `--candidates`; for a timeline, `--sort oldest` with
     smaller `--before/--after`), raise `--max-chars` second.
   - `+N forked copies` → the same message replayed by resumed sessions; the pointer
     shown is the earliest copy.
4. **Drill in.** Every hit is a pointer: `--session ID --at IDX` from its header returns
   the exact messages around it without re-searching; add `--focus TEXT` so a long
   message opens centred on the span that matched instead of its start. Done when the
   answer is quoted with source, `id`/`idx`, and timestamp.

For a broad ask ("what was session X about", "which session did Y"): `--overview` to
find the session, `--skim ID` for its shape, then step 2 for specifics. Answer by
summarizing the hits with source, id/path, timestamp, and the context needed.

## Tiers and what each costs

Budgets are BYTES; ~4 bytes ≈ 1 token, so the default 8k is roughly 2k tokens per call.
Pick the cheapest tier that answers the question.

| tier | call | returns | typical cost |
|---|---|---|---|
| 1 inventory | `--overview` | 2-line digest per session: id, span, counts, opening | ≤ 8k bytes |
| 2 shape | `--skim ID` | one session's spine, head/tail kept, middle sampled | ≤ 16k bytes |
| 3 evidence | `--query` / `--any` | ranked hits with ±context and pointers | ≤ 8k bytes |
| 4 drill-in | `--session ID --at IDX` | the exact messages around one hit | ≤ 8k, usually far less |

One tier-3 query usually locates both the session and the evidence; open tier 2 on a
single session, not several.

## Semantics

**Scores.** `--any` ranks by BM25 over per-run statistics (rarity, saturated term
frequency, length), so scores compare within one result set and never across runs.
Ties break by recency (newest, or oldest under `--sort oldest`), then session id and
index. To compare candidate terms, put them in one `--any` query.

`--rerank jev` reranks the first 20 grouped lexical candidates by semantic relevance.
It requires `--any --candidates` and `--limit 20` or lower. `score` remains the lexical
BM25 score. `semanticScore` is Jev's finite relevance score. Equal semantic scores keep
the lexical order. Scoring is per candidate: a candidate Jev could not score keeps its
lexical rank, and the scored candidates reorder only among the positions they already
hold, so one failed row never moves another. With nothing scored the result is the
unchanged lexical order. session-grep sets no timeout of its own — `jev` bounds each
request (`JEV_TIMEOUT_MS`, default 60s, with `JEV_MAX_RETRIES` retries). Set
`SESSION_GREP_JEV_BIN` to select the executable.

`--filter jev` scores the same pool but does not reorder it: candidates below 0.5 are
dropped and the rest keep lexical order, with the count reported as `jev_dropped=` and
`jevDropped`. A dropped candidate frees a slot rather than being replaced by an unscored
one, so the result is shorter, not rebuilt. An unscored candidate is kept. Prefer this
over `--rerank jev` for narrowing: on measured queries lexical order held up better than
Jev's ordering, while Jev reliably identified irrelevance. The two cannot be combined.
Jev is optional. When it is missing, cannot start, or returns nothing usable, the full
lexical result is returned and `jev_filter_skipped=` names the reason, so an unfiltered
result is never mistaken for a filtered one that found nothing. Pools under 10 candidates
skip the call for the same reason, since below that size the median call drops nothing and
only narrows evidence the agent re-searches for. The exit code is unaffected either way.
The subprocess receives only the query and the best matching message excerpt. Each run
caps the query at 512 bytes, each excerpt at 1,000 bytes, the batch at 20 sessions, and
stdin at 32 KiB. It never receives session IDs, paths, timestamps, context messages,
tool output, skill bodies, or transcript JSONL.

**Budget.** The byte ceiling is absolute; every line is charged, and excess hits are
omitted with a notice. Four trade-offs enforce it. (1) Selection is a strict rank-order
prefix: competing hits are each capped to one-third of the budget and selection stops at
the first that does not fit, so raising `--max-chars` only adds hits or lengthens
previews. An oversized match is truncated around the matching span so the hit stays
visible. (2) Fork/resume descendants replay their ancestor's prefix, so a copy is one whose
messages BEFORE the hit are identical, and whose hit text is identical; copies collapse
onto the earliest. Sessions that merely repeat a common line stay separate, and a hit at
index 0 never collapses because nothing was replayed before it.
(3) Near the floor, the `word_hits` table is dropped before any evidence. (4) As a last
resort the sole shown hit sheds context and truncates its path (`...`); the `id`/`idx`
pointer always stays valid. These degradations engage only near the 500-byte floor.

**Exclusions.** Tool results (~45% of bytes, file and command echoes) and injected
slash-command skill bodies (~12.8% of conversational bytes, matching their own
vocabulary) are excluded by default. The invocation record (`<command-message>` and
friends) is never excluded. `--role assistant` skips user-side harness wrappers and
review prompts that otherwise dominate keyword-dense `--candidates` BEST hits.

## Flags

`node session-grep.mjs --help` lists every flag with its argument and default. The ones
whose reason is not in that line:

- `--include-tools` / `--include-skill-bodies` lift the default exclusions described under
  Semantics; message indexes depend on them, so drill in with the setting the search used.
- `--role assistant` is the lever against user-side wrappers and review prompts (see
  Semantics).
- `--target-root DIR` and `--target-type` keep the configured `{ type, root }` parser
  mapping; `--root DIR` is an untyped one-off whose format is auto-detected, and it cannot
  be combined with `--sources-file`.
- `--exclude-re` applies to every mode, so a wrapper can enforce a path blacklist;
  `--exclude-session` follows canonical ids rather than filenames.
- `--rerank jev` is opt-in. Install Jev separately or set `SESSION_GREP_JEV_BIN`.
- `--self-test` after copying the skill anywhere.
