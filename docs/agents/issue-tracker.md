# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues at `PsychedelicShayna/omomp`. Use the `gh` CLI from this clone so it resolves the repository from `origin`.

## Conventions

- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <number> --comments`, including labels.
- List: `gh issue list --state <state> --json number,title,body,labels,comments` with the filters the task requires.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close only when the user or invoked workflow authorizes it.
- The repository's GitHub rules in `AGENTS.md` remain authoritative. This guide describes mechanics and does not authorize unsolicited comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill meanings

- "Publish to the issue tracker" means create a GitHub issue.
- "Fetch the relevant ticket" means read the GitHub issue, its comments, and labels.

## Dual taxonomy

House labels (type, `effort:*`, `priority:*`, and `entangled` only for true alternative clusters) and Matt triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) are **orthogonal layers**, not replacements. An issue may carry both. Do not strip house labels to be Matt-only. The Issue Funnel contract is `docs/agents/issue-funnel.md`.
