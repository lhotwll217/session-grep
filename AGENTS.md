# session-grep — agent notes

Literal/regex grep over local AI session transcripts with bounded, budgeted output. The canonical skill lives in `skills/session-grep/`; the eval harness lives in `eval/`.

Keep the package pure: zero runtime dependencies, zero persistent state, one copyable folder. See `eval/AUTORESEARCH.md` for the eval protocol (one mechanism per iteration; ranking changes must clear the noise floor).

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues (`gh` CLI); external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily; absent today). See `docs/agents/domain.md`.
