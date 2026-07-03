# session-grep

Grep across local AI coding-session transcripts (Claude Code, Codex) with **bounded
message context** — built for agents answering questions about past sessions.

Session history is a knowledge base — decisions, incidents, rules, dead ends — but
the transcripts are hostile to search: conversational text is under 2% of bytes; the
rest is tool output, thinking blocks, and base64. Raw grep returns whole JSONL records
(10-100KB each); loading transcripts wholesale blows up context windows. session-grep
parses records into messages, matches against conversation (not tool echoes), and
returns ranked hits with a hard output budget.

## Install

```bash
npx skills add lhotwll217/session-grep                    # as an agent skill
npx session-grep --query "why did you" --since 7d         # as a CLI, no install
npm i -g session-grep                                     # or global
npx session-grep --self-test                              # verify: 22 built-in assertions
```

Needs Node ≥ 20 and ripgrep. The skill is the [skills/session-grep/](skills/session-grep/)
folder (SKILL.md + script + adapters) — installable via `npx skills add`, or copy it into
any skills directory; the self-test travels with it. Session formats are pluggable: one
adapter file per tool in `adapters/`, drop in a new one to support another harness.

## Use

```bash
session-grep --query "task_started" --before 2 --after 2      # exact term, bounded context
session-grep --query "sidebar poll triage membership" --any   # multi-word: rarity-ranked, per-word hit counts
session-grep --overview                                       # one-line digest per session
session-grep --skim 269a                                     # one session's conversation, sampled to budget
```

Searches `~/.claude/projects` and `~/.codex/sessions` by default; `--root DIR` points
anywhere. Full flags and agent guidance: [skills/session-grep/SKILL.md](skills/session-grep/SKILL.md).

## Benchmark

`eval/` is a promptfoo benchmark: an agent equipped with session-grep vs a naive-grep
control, rubric-graded questions over real session history, measured in cost,
correctness, tool calls, and time. The harness ships; our transcripts and cases stay
local (documented in [eval/README.md](eval/README.md)). Our result — 29 questions
over 24MB of real sessions, haiku subject:

|  | session-grep | naive control |
|---|---|---|
| correct | **79%** (23/29) | 45% (13/29) |
| cost | **$1.25** (0.41×) | $3.02 |
| tool calls | **130** (3.3× fewer) | 423 |
| time per question | **25s** (2.2× faster) | 54s |

Cheaper on 26/29 questions; $0.054 vs $0.233 per correct answer. Target gate:
≤0.5× cost at ≥ control correctness (`node eval/compare.mjs --gate`).

To create your own eval on your own sessions (and tailor the tool with the
improvement loop), see [eval/README.md](eval/README.md) and
[eval/AUTORESEARCH.md](eval/AUTORESEARCH.md).

## Origin

Ported from [owner-operator](https://github.com/lhotwll217/owner-operator)'s
`sessions-grep` skill; benchmarked on that project's own development sessions.

## License

MIT
