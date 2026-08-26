Update this local `omomp` fork checkout to the latest upstream Oh My Pi release and leave it installed and ready to use.

Work autonomously through the complete update:

- Confirm you are operating in the `PsychedelicShayna/omomp` checkout. If the current directory is not that checkout, locate it before changing anything; do not update an unrelated repository.
- Read and obey the checkout's `AGENTS.md`, especially the binary-install hard rule.
- Inspect the branch, remotes, tags, commits, and worktree. Preserve relevant local work and make the worktree safe before synchronizing; commit coherent pre-existing changes when appropriate rather than discarding them.
- Fetch the `upstream` remote and tags, identify the latest release, and merge the corresponding upstream state into the fork branch. Create a recovery ref first. Resolve every conflict deliberately, preserving both current upstream behavior and intentional fork behavior.
- Update fork-specific automation or documentation when upstream changes make it necessary. Do not erase fork features merely to make the merge easy.
- Run focused tests for conflict resolutions and fork changes, then the repository's required checks and build. Fix failures caused by the update.
- Build `packages/coding-agent/dist/omp`, but NEVER replace, overwrite, move, relink, or reinstall the live `omp` binary.
- Install the built artifact only as the separate `omomp` executable at the existing `omomp` location on `PATH` (normally `~/.local/bin/omomp`). Deploy the fork extensions with `bun scripts/install-omomp-extensions.ts`.
- Smoke-test the installed `omomp` executable, verify the expected version, and verify that the original `omp` installation was untouched.
- Commit the completed update in small logical commits and finish with a clean worktree. Report the upstream version, conflict decisions, tests, build, install target, extension deployment, smoke test, commits, and any remaining blocker.

Do not invoke the upstream `omp update` installer or any setup/link command that targets the `omp` name. The purpose of this command is to update this source fork and its separate `omomp` installation.