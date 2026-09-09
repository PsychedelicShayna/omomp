# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `oh-my-pi` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.

## Chronicler capture

Chronicler is an independent, opt-in background capture feature, not a memory backend or advisor. In `/settings` → Memory, **Chronicler capture** appears directly beneath **Memory Backend**; it can run alongside Local memory. The built-in `chronicler` model role is selectable in the ordinary role UI and cannot be deleted. An unset role follows the `slow` fallback chain.

For example, in `~/.omp/agent/config.yml` or project `.omp/config.yml`:

```yaml
memory:
  backend: local
chronicler:
  enabled: true
modelRoles:
  chronicler: openai-codex/gpt-5.6-luna:max
```

The model choice is configuration, not a hard-coded requirement. Capture defaults off and is always disabled for task subagents, including SDK sessions identified by `taskDepth` or `parentTaskPrefix`. No primary-agent `retain` call, advisor, or prose reviewer is involved.

Enabled sessions capture their remaining persisted append history in bounded passes, including idle resumed sessions. Each pass can stage standalone markdown beats and retain bounded pending carry for an unfinished thought. Intentions remain distinct from observed results; corrections create linked new beats rather than rewriting old ones. Missing completion markers, provider failures, or revocation do not advance coverage. An oversized individual entry pauses capture with a warning and remains unprocessed; selecting a suitable model or toggling capture off and on retries it without truncation.

Files live beneath that session’s own artifacts directory, in `chronicler/`:

- `beats/<batch-id>/COMMIT.json` records the covered entry IDs, parent links, timestamps, and carry. Its immutable markdown beat files include session, source, model, and time provenance. A completed pass with no beat still commits entry coverage.
- The manifest and beats publish together through one directory rename. A process interrupted before publication leaves no committed coverage; reopening after publication recovers coverage from the committed batch without replaying it. Abandoned `.pending-*` directories are ignored. This is local-filesystem process-interruption recovery, not a power-loss guarantee or a claim that models never repeat an idea.
- `INDEX.md` and `state.json` are rebuildable caches, not checkpoint authority. Corrupt committed manifests or missing referenced beats halt capture and preserve the files instead of silently recapturing.
- `__chronicler.jsonl` is the diagnostic model transcript, not replay authority.

Distinct sessions in one working directory have distinct artifact roots. Copied-artifact forks (`SessionManager.forkFrom` and `AgentSession.fork`) retain ancestor beat provenance and committed coverage. Interactive `AgentSession.branch` uses `createBranchedSession`, which records the source session file as its parent but does **not** copy artifacts: its fresh root captures the branch’s transcript under the child session identity. A plain in-process `SessionManager.fork()` does not copy artifacts either. These existing branch/fork semantics are unchanged.

This feature provides capture only. It adds no default recall injection, cross-session index, hierarchical recall, refinement, or reflection pipeline.
