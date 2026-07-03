# eval/ — the benchmark & development harness

The harness ships; the specimens don't. Everything needed to benchmark session-grep
against a naive-grep control on **your own sessions** is committed here. Our
transcripts, the cases mined from them, and raw run outputs are local-only
(gitignored) — the results and a description of what we ran are documented below.

If you just want to *use* the skill, you need none of this — see the repo README.

## Results (our corpus, documented; corpus not distributed)

Full suite: 29 rubric-graded questions, haiku subject model, agent-with-session-grep
vs a naive-grep control with the same generic tools. The control is the fixed
reference; the tool is measured before (v0 port) and after the auto-research campaign:

| | naive (control) | session-grep v0 | **session-grep final** | autoresearch Δ (v0→final) | final vs naive |
|---|---|---|---|---|---|
| correct | 13/29 (45%) | 16/29 (55%) | **23/29 (79%)** | **+24 pts** | **+34 pts** |
| cost | $3.02 | $2.03 | **$1.25** | **-38%** | **0.41×** |
| tool calls | 423 | 262 | **130** | **-50%** | **3.3× fewer** |
| time/question | 54s | 36s | **25s** | **-31%** | **2.2× faster** |
| $/correct answer | $0.233 | $0.127 | **$0.054** | **2.3× better** | **4.3× better** |

Gate (≤0.5× cost at ≥ control correctness): **PASS** — cheaper on 26/29 cases.
A 6-case extension suite on real Codex-format rollouts scored 6/6 (naive 4/6),
including two cross-tool questions assembled from both formats in one trajectory.

**What we ran it on** (local-only): 10 real sessions from developing
[owner-operator](https://github.com/lhotwll217/owner-operator) — 6 Claude Code
sessions (24MB, June-July 2026) + 4 Codex CLI rollouts (3.8MB), spanning multi-day
builds, code reviews, debugging, and doc work. 35 cases total: needle facts,
incident synthesis, decision traces, whole-session summaries, grounded
retrospectives, cross-session and cross-tool assembly; ~half "hard" (paraphrased so
question words don't appear verbatim). Conversational text was <2% of corpus bytes —
the noise ratio the tool exists to beat.

The campaign that produced this (5 accepted mechanisms, 1 revert, ~20 runs, ~$35 of
model spend) is recorded line-by-line in `history.jsonl` (committed — numbers, gates,
artifact hashes per run). Caveat: single run per case with known per-case variance.

## Create and run your own eval

Needs: Node ≥ 20, ripgrep, promptfoo, a logged-in Claude Code CLI (no API key).

1. **Corpus** — point at any directory of session `*.jsonl` files:
   `export SESSION_GREP_EVAL_FIXTURES=/path/to/your/transcripts`
   (e.g. copy a project's sessions from `~/.claude/projects/<project>/`).
2. **Cases** — `cp eval/cases.example.yaml eval/cases.yaml`, then write questions
   about your sessions. Mine ground truth from the transcripts first; the example
   file documents the qtype/difficulty spread and rubric calibration that worked.
3. **Run the ladder** (cheapest signal first — full runs are a bottleneck):
   ```bash
   node eval/loop.mjs --cases my-case-id      # one case (~2 min): does it work at all?
   node eval/loop.mjs --probe                 # 3 cases (edit PROBE_IDS in loop.mjs)
   node eval/loop.mjs                         # core set (edit CORE_IDS to your ids)
   node eval/loop.mjs --full --label baseline # everything — your baseline record
   ```
4. **Read results**: gates print per run; `eval/history.jsonl` accrues one record per
   run; trajectories land in `eval/results/logs/<runId>/` (what each agent actually
   did); `npm run eval:view` opens the promptfoo UI.

## What's here

| path | what | committed? |
|---|---|---|
| `promptfooconfig.yaml` | the benchmark: 2 arms x pinned models | yes |
| `promptfooconfig-smoke.yaml` | release smoke: session-grep arm only | yes |
| `cases.example.yaml` | case template + design notes | yes |
| `cases.yaml` | YOUR cases (rubrics contain transcript facts) | no |
| `fixtures/` | YOUR transcript corpus | no |
| `providers/` | headless `claude -p` subject runner + rubric grader | yes |
| `loop.mjs` / `compare.mjs` | iteration runner + gate | yes |
| `test/` | repo unit tests (`npm test`) | yes |
| `history.jsonl` | one numbers-only record per run — the results artifact | yes |
| `findings.jsonl` | qualitative insights (quotes transcripts) | no |
| `results/` | trajectories, per-case detail, promptfoo output | no |

## Improving the tool against your eval

The loop protocol — reflection over trajectories, one mechanism per iteration, the
probe→core→full ladder, accept/reject on paired per-case stats, holdout discipline —
is in [AUTORESEARCH.md](AUTORESEARCH.md). Every mechanism in the shipped tool came
out of this loop; your corpus will suggest different ones.
