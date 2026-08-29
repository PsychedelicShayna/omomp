# omomp fork

This tree is [PsychedelicShayna/omomp](https://github.com/PsychedelicShayna/omomp), a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). Upstream still ships as `omp`. This checkout installs as a separate binary named `omomp`. Do not overwrite a live `omp` on `PATH`. The hard rule lives in `AGENTS.md`.

This note records committed fork work only. Dirty live-controller experiments in the working tree are not shipped history.

## How to re-diff

As of 29 Aug 2026 the comparison base is `upstream/main` at `33cc6b9a043a74e00a157e72ca909272796d8461`, which equals tag `v18.0.10` and `git merge-base omomp upstream/main`.

```sh
git log --no-merges upstream/main..omomp
git diff --stat upstream/main...omomp
```

Local `omomp` then sat at merge `b41d0f60c15245ace5cc900f76288461a1d62c4c`. The first fork batch is 11 Aug 2026. The latest non-merge on that range is `d9339a9e1d007c9f7a27247ddf0dc7fb30cd5ce5`, 27 Aug 2026. Counts move; re-run the commands.

The kernels for Python, JavaScript, Ruby, and Julia already existed upstream for the `eval` tool. The fork opened the user eval path to those languages, then added extensions, live voice, and install policy around that.

## User eval: JavaScript, Ruby, Julia, and plugins

Landed 11 Aug 2026, with follow-up through 27 Aug.

User cells used to be a Python-only path. They now go through `EvalRunner` and a session-scoped `EvalBackendRegistry`. Builtin tokens:

- `py` / `python`
- `js` / `javascript`
- `rb` / `ruby`
- `jl` / `julia`

Those map onto the existing `eval` backends in `packages/coding-agent/src/eval/`. Extensions may `registerEvalBackend` with any other token. `py`, `js`, `rb`, and `jl` stay reserved so a plugin cannot steal them.

A busy gate is per language, so independent kernels can run at the same time. Old `pythonExecution` session records still obfuscate and replay. User cells route through `handleEvalCommand`. The REPL prefix parser lives in `repl-input.ts`.

Provenance, 11 Aug: `243cb14bb5`, `0d81cc5273`, `fb0119faba`, `7342fba72b`, `a7caec171b`. Then `935dea0259` on 22 Aug for the per-language gate, `95e78b125c` on 26 Aug for bounded availability probes, `d9339a9e1d` on 27 Aug for the test fixture.

## Runtime model loadouts

11 Aug 2026. `c81c99786e`, `29d9fc3597`.

`Settings.applyRuntimeOverridesAtomically` swaps `modelRoles`, `retry.fallbackChains`, and `task.agentModelOverrides` as one volatile overlay, with a baseline restore. `AgentSession.applyRuntimeModelLoadout` is idle-only. Extensions see `ctx.applyRuntimeModelLoadout`.

On a stock `omp` build that method is missing, and `/loadout` reports the gap instead of switching.

## External harness dispatch

11 Aug 2026. `cc3819def5`, `2407c059ba`, `c9ca7ae0a5`.

Agent frontmatter may set `harness: omp | claude | codex`. Claude has an adapter and a sidecar. Codex has adapter code under `task/external-harness/codex.ts`, but `assertExternalHarnessCapabilities` throws for `harness: codex` because tools and containment cannot be represented exactly. Treat Codex dispatch as present in the tree and disabled, not as a working feature.

## Fork extensions

Added 11 Aug 2026 as `bomp-*`, renamed 22 Aug in `a176f94a08` to `omomp-*`. Overlay dashboards came out the same day in `4aea05b2fb`. The menus now use `ctx.ui.select` / `input` / `editor` / `confirm`.

| command | directory | state file |
| --- | --- | --- |
| `/persona` | `extensions/omomp-persona/` | `omomp-persona.json` |
| `/loadout` | `extensions/omomp-loadout/` | `omomp-loadout.json` |
| `/repl` | `extensions/omomp-repl/` | `omomp-repl.json` |
| `/live-persona` | `extensions/omomp-live-persona/` | `omomp-live-personas.json` |

`/persona` swaps session system-prompt personas. Modes are replace, prepend, append, or literal-substitute. `/repl` picks agent chat or a builtin eval backend: Python, JavaScript, Ruby, or Julia. It can register extra shell or Jupyter backends when `registerEvalBackend` exists. `/live-persona` is command UX over `packages/coding-agent/src/live/personas.ts`.

`packages/coding-agent/src/modes/components/dashboard-kit.ts` is still in the tree after the overlay rip-out. Nothing imports it. It is leftover, not a product.

## Iris live voice

22 Aug through 26 Aug 2026.

The voice model is Iris, not the coding agent wearing a headset. Relays stay silent unless addressed. A live handoff aborts the backend through a bounded subscriber drain so barge-in works. Answers can be spoken while background jobs keep the session awake. Crew IRC and provisional reasoning go on a speakable channel. Live personas resolve transport instructions. Speakable chunks are truncated on Unicode code points, not raw bytes.

Key commits: `c7bb908557`, `7a87cfe115`, `3b4dd762b6`, `6fa90d9a09`, `14c6e4406f`, `21b0e7cf7e`, `6983ee1a60`, `990964437a`, `4eb5e2594f`, `a991cf58d0`.

Uncommitted edits in `live/controller.ts` and `agent-session.ts` are a later redesign. They are not part of this record.

## Model selectors on `task`

23 Aug 2026. `e4fadf1299`, `7039de1ad4`.

A non-registered `agent` value shaped like `provider/model[:effort]` or `@role[:effort]` crews the generic task agent. Registered agent names still win. Bad selectors fail at preflight instead of silently falling through.

## Binary, extensions deploy, `omomp update`

22 Aug through 27 Aug 2026.

`AGENTS.md` is the policy: never touch `PATH` `omp`; install this fork only as `omomp`; cap `cargo -j 6`. Early notes said `om-omp`; `e795702ff4` corrected the name.

`scripts/install-omomp-extensions.ts` symlinks `extensions/` into the active agent extensions dir, renaming collisions aside, with rollback. `bun setup` and a local coding-agent build already run it. Failures after an automatic post-build deploy warn and leave the binary in place.

Exact argv `omomp update`, basename plus that one argument, launches an agent session on `packages/coding-agent/src/prompts/omomp-update.md`. `omp update`, `--check`, `--help`, and any extra flags stay on the upstream updater.

Provenance: `da8bb86645`, `e795702ff4`, `64380829e2`, `05380db554`, `bc1c74703d`.

## Upstream merges

Bookkeeping only. The tip merge is `b41d0f60c1`, subject `Merge upstream v18.0.10 into omomp`. Earlier: `b2b440dd27`, `18c553f29e`, `fea38c78ad`, `3ba6ea8dbb`, `35f3e870da`.

## What this file is not

- Not a changelog of can1357/oh-my-pi.
- Not a promise about uncommitted live-controller work.
- Not a claim that Codex external harness dispatch works.
- Not a rewrite of the upstream rules pipeline. Per-file `rules/*.md` composition, sticky `RULES.md`, and `/status` toggles that need a new session are upstream behavior this fork did not change.
