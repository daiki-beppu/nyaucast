# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md          ← グロッサリ（用語の正書。実装詳細は書かない）
├── docs/adr/
│   ├── 0001-thin-architecture.md
│   ├── 0002-no-llm-in-core.md
│   ├── 0003-bun-only-distribution.md
│   ├── 0004-auto-migration.md
│   ├── 0005-media-processing-foundation.md
│   ├── 0006-no-takt-for-product-orchestration.md
│   ├── 0007-collection-lifecycle-execution-model.md
│   └── 0008-takt-dedicated-workflow.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (thin architecture) — but worth reopening because…_
