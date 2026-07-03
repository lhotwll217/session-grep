# The auto-research loop

The benchmark isn't a one-shot scorecard — it's the feedback signal for iterating on
session-grep itself. Run → read trajectories → change one thing → re-run → keep only
what moves the gate. The loop is designed so an agent (or a human) can run it end to
end without extra instrumentation.

Target: **session-grep arm ≤ 50% of the naive-grep control's cost, at correctness ≥
the control, per subject model** (`node eval/compare.mjs --gate` exits non-zero until
it holds — the stop condition for an autonomous loop).

## The loop

```
1. RUN      node eval/loop.mjs --label "iterN: <hypothesis>" [--probe|--cases a,b|--full]
            # runs the eval, appends a timestamped record to eval/history.jsonl,
            # writes per-case detail to eval/results/iterations/<runId>.json,
            # and prints the delta vs the previous comparable iteration
2. INSPECT  eval/results/logs/<runId>/         # HOW each arm searched, per case
3. DIAGNOSE which cases fail or cost too much, and why (see "reading a trajectory");
            append one line per insight to eval/findings.jsonl
4. CHANGE   one thing: bin/session-grep.mjs (tool behavior), the arm system prompt in
            eval/providers/claude-agent.mjs (strategy), or SKILL.md (guidance)
5. RE-RUN   cheapest tier that can see the effect, then climb
6. KEEP/REVERT based on the paired per-case deltas, not just aggregate means
```

The iteration ladder — full runs are a bottleneck; stay low while proving a mechanism,
and climb ONLY on a win at the current rung:

1. `--cases <one-heavy-case>` — ONE case first (usually context-blowup: biggest
   session, hard paraphrase). ~2 min. Iterate here until the mechanism visibly works.
2. `--probe` — 3 distributed cases: confirms you're not indexing on the one case.
3. core (default) — 8 cases: the accept/reject decision.
4. `--full` — 29 cases: holdout confirmation that the improvement is global, ONLY
   after the lower rungs all agree (every 3-5 accepted changes and at campaign end).

All quantitative state lives in JSONL so it's trivial to run math on:

- `eval/history.jsonl` — one line per iteration: label, scope, per-arm aggregates,
  per-model gates (costRatio, accSg, accNv, cheaperWins). Committed.
- `eval/findings.jsonl` — one line per qualitative insight: ts, kind, finding,
  evidence pointer, action, status. Committed.
- `eval/results/` — bulky regenerable artifacts (latest.json, per-iteration case
  detail, raw trajectories). Gitignored.

Target: **session-grep arm cost ≤ 50% of the naive arm, at correctness ≥ the naive
arm, per subject model.** `node eval/compare.mjs --gate` exits non-zero until that
holds — usable as the stop condition for an autonomous loop.

## What's in the logs

Each run writes `eval/results/logs/<timestamp>/`:

- `<case>.<arm>.<model>.jsonl` — the full stream-json trajectory of that agent run:
  every tool call (with input), every tool result, thinking, final answer.
- `summary.jsonl` — one line per run: cost, tokens (total/uncached/output), turns,
  tool calls (with compacted inputs), tool-result chars, and the log file path.

`eval/results/latest.json` is the promptfoo output: per-case rubric verdicts with the
grader's reasoning, namedScores, and provider metadata. The promptfoo web UI
(`npm run eval:view`) is the human view of the same data.

## Reading a trajectory (what to look for)

- **Query choice** — did the agent grep for stopwords/common phrases ("the sidebar",
  "what happened") instead of rare identifiers? Count hits per query in the summary:
  high `toolResultChars` on early calls means the query was too broad.
- **Aperture** — did it re-query with wider `--before/--after` when it already had the
  right hit, or pull context it never used?
- **Traversal** — how many probes before landing on the right session? Did recency
  ordering help or mislead (`--sort newest` on a June question)?
- **Noise** — did matches land in tool_result noise rather than conversational text?
  (~78% of fixture bytes are tool results/thinking/images; matches there are usually
  echoes of the real conversation, at 10-100x the size.)
- **Naive-arm behavior** — what does the control do that's expensive? That's the
  budget the tool needs to beat, and often the best source of feature ideas.

## Improvement backlog (hypotheses to test, one at a time)

- Filter tool_result/toolUseResult/thinking content out of matching by default
  (`--include-tools` to opt back in) — conversational text is ~2% of bytes.
- Per-file hit summaries before full hits (progressive disclosure: "session X: 41
  hits, first/last timestamps" first, drill in second — cf. Grep's files_with_matches).
- Query-term advice or automatic stopword rejection (warn when a query term appears
  in >N% of messages — it's a low-signal word).
- Sampling mode for summary-type questions: conversational spine extraction
  (user text + assistant text only, head/tail or stratified).
- Bounded output budget per call (chars cap with "how to get more" hint), so a bad
  query can't dump 100KB into context.
- Session-level metadata in results (ai-title, first prompt, date range) so the agent
  can identify the right session in one probe.

## Protocol (distilled from GEPA / OPRO / Anthropic + OpenAI eval guidance)

**Train/holdout split.** The 8 core cases are the train set; the other 21 are holdout.
Run holdout (`--full`) only every 3-5 accepted changes and at campaign end. Never edit
tool/prompt in direct response to a specific holdout failure — that promotes it into
the train set. If core climbs while holdout stays flat, you are overfitting: stop and
do error analysis on holdout trajectories without case-specific fixes.

**Reflect before editing (the GEPA trick).** The trajectory is the gradient: read the
failing/expensive transcripts and write a one-sentence causal diagnosis per problem
into findings.jsonl BEFORE changing anything. Fix the biggest failure bucket, not the
most recent one.

**One mechanism per iteration.** A tool-output change plus its matching skill-prompt
sentence counts as one mechanism; two unrelated edits do not. Log the hypothesis and
expected effect in the --label/--notes before running.

**Accept/reject on paired per-case stats, never aggregate means:**
- Correctness veto: no case that passed at baseline may flip to fail (any flip → read
  the transcript; distinguish agent mistake vs grader mistake before deciding).
- Cost: median per-case ratio and cheaperWins must improve; one runaway trajectory
  wrecks a mean, so ignore aggregate-only movement.
- Noise floor: subject runs vary even at fixed settings (agent evals show >1.5pp
  per-task SD at temp 0). With 8 cases x 1 repeat, effects smaller than one case-flip
  or <10% cost delta are invisible — journal them, don't accept them. For contested
  correctness changes, re-run with --repeat 3 on the disputed cases. Cost metrics are
  much lower-variance than pass/fail; trust them from fewer runs.
- Regression watchlist: any case that ever flipped pass→fail is permanently mandatory
  in every later run.
- Keep per-case bests (the Pareto idea): a reverted change that uniquely fixed one
  case is a lesson to merge later, not garbage — record it in findings.jsonl.

**Stop conditions.** Two consecutive iterations with no acceptable change (plateau),
or the core set saturates at 100% correct (no signal left — add harder cases rather
than trusting further gains). Final report = full 29, both arms, --repeat 3; the
holdout cases are the honest number, core is train-contaminated.

**Grader discipline.** The grader model, rubric texts, and grader system prompt are
frozen for a campaign; changing any of them invalidates prior comparisons (re-baseline).
The grader judges core facts only — never length/style (verbosity bias favors the
control's longer answers). Grader cost is excluded from trajectory-cost metrics.

**Controls.** The naive arm is the control — never "improve" it, and never let the
skill arm's system prompt leak case-specific hints (session ids, dates, keywords from
cases.yaml). Fixtures are frozen; new fixtures mean new cases, not edits to existing
ones.
