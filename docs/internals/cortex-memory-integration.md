# Cortex memory and Engineering Brain

Cortex turns repository knowledge and completed work into cited context that can be reused across sessions, runtimes, and related repositories.

## Inputs

Cortex indexes several kinds of evidence:

- Repository documentation, including root instruction files and `docs/**/*.md`.
- Operator-authored directives and accepted organizational rules.
- Completed session outcomes, review decisions, and approval history.
- Structured project and repository records.
- Facts extracted through the distillation pipeline.

Source identity remains attached to each record so retrieval can explain where an answer came from.

## Ingestion

Repository ingestion lives under `src/lib/cortex/ingest/`. It walks supported documentation and source surfaces, normalizes records, and updates SQLite and full-text indexes. The specification ingester separately converts trusted repository instructions into retrievable directives.

The indexer is project-aware. When a repository belongs to a multi-repo project, retrieval can include related repositories while giving the active repository a ranking preference.

## Retrieval

The Engineering Brain combines:

- Full-text retrieval for exact names, paths, and phrases.
- Structured queries for known project, lane, approval, and outcome records.
- Fact and directive retrieval for durable organizational knowledge.
- Answer composition that cites the records used.

The public operator entry points are `o8 ask` in the CLI and the corresponding Cortex MCP tool. Retrieval answers questions; it does not mutate the repository or authorize an action.

## Feedback and promotion

Workers contribute candidate knowledge through `o8 cortex observe`. Observations are queued as regressions, patterns, gotchas, or preferences. The operator can accept a proposed directive, making it durable for future dispatches, or dismiss it.

This boundary keeps session observations useful without letting a worker silently rewrite organizational policy.

## Persistence

Cortex state is stored with the rest of the local control plane under `~/.o8` by default. `CORTEX_IDE_DATA_DIR` redirects it for tests or isolated installations. SQLite migrations own the durable schema; callers should use the repository’s database and ingestion APIs rather than reading files directly.

## Invariants

- Every synthesized answer should retain inspectable citations.
- Current repository state outranks stale memory when they conflict.
- Project scope must be explicit enough to prevent unrelated repositories from contaminating an answer.
- Missing or malformed indexes fail closed or degrade to narrower retrieval; they never manufacture evidence.
- Retrieved context can inform planning and review, but it cannot bypass principal checks, tests, or approval gates.
