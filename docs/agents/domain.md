# Domain docs

OMP uses a multi-context domain layout.

## Before exploring

- Read root `CONTEXT-MAP.md` when it exists. It points to the context documents relevant to each package or subsystem.
- Read root `docs/adr/` entries that affect system-wide behavior.
- Read the selected package or crate's `CONTEXT.md` and local `docs/adr/` entries when present.
- If a named file does not exist, proceed silently. Domain-modeling workflows create these files lazily when the vocabulary or decision exists.

## Layout

- `CONTEXT-MAP.md`: routes topics to context documents.
- `docs/adr/`: system-wide architectural decisions.
- `packages/<context>/CONTEXT.md`: TypeScript package or subsystem vocabulary.
- `packages/<context>/docs/adr/`: package-scoped decisions.
- `crates/<context>/CONTEXT.md`: Rust crate vocabulary.
- `crates/<context>/docs/adr/`: crate-scoped decisions.

Use terms from the relevant `CONTEXT.md` in issues, proposals, hypotheses, and test names. Surface conflicts with an existing ADR instead of silently overriding it.
