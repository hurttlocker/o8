# Cortex Multi-Hop Planner and Temporal Fix Plan

## Purpose

This is a concrete implementation plan for two Cortex retrieval improvements that came out of the LoCoMo benchmark:

1. a bounded multi-hop search planner
2. the smallest temporal fix that should materially improve benchmark behavior

This doc is written for review and go/no-go, not as a speculative design note.

## Why This Work Exists

From the current LoCoMo benchmark:

- BM25 top-5 evidence hit: `68.90%`
- Hybrid top-5 evidence hit: `77.66%`
- Hybrid evidence recall: `71.26%`
- Hybrid + reader F1: `33.78%`

The failure pattern is consistent:

- category 2 temporal questions retrieve the right neighborhood but not normalized dates
- category 3 multi-hop questions retrieve one side of the answer, not the composed evidence set

## Recommendation

Recommended go path:

1. ship the temporal anchor patch first
2. rerun the LoCoMo slice to verify a real category 2 gain
3. then ship the multi-hop planner behind an explicit flag

Do not start with an LLM planner. Cortex already has enough primitives to build a deterministic planner first.

## Current Implementation Seams

Relevant Cortex files in the `hurttlocker/cortex` repo:

- `internal/ingest/ingest.go`
  creates `store.Memory` at import time
- `internal/store/store.go`
  already has `Metadata.TimestampStart`
- `internal/store/metadata.go`
  already injects `date:YYYY-MM-DD` into the FTS metadata prefix when `TimestampStart` is populated
- `internal/store/context.go`
  builds the embedding context prefix
- `internal/search/search.go`
  is the main search pipeline and already supports `bm25`, `semantic`, `hybrid`, `rrf`
- `internal/search/expand.go`
  already provides multi-query expansion
- `internal/reason/recursive.go`
  already shows a bounded “search again with a different angle” loop
- `internal/answer/engine.go`
  builds the retrieval-only answer context shown to the reader model

## Phase 1: Minimum Temporal Fix

### Goal

Close the temporal gap with the smallest possible surface area.

### What “minimum” means here

No schema migration.
No new storage tables.
No LLM extraction changes.
No benchmark-specific code path.

### Root Cause

For transcript-like corpora, Cortex often stores the session date in `SourceSection`, but does not promote that date into normalized memory metadata. The retrieval/answer stack therefore sees:

- human-readable section text like `Session 7 - 7:28 pm on 23 March, 2023`
- relative language in the chunk like `last week`, `Sunday`, `next month`

It does not consistently surface a clean absolute anchor like `2023-03-23`.

### Proposed Change

#### 1. Parse session date from `SourceSection` during ingest

Target files:

- `internal/ingest/ingest.go`
- new helper: `internal/ingest/source_section_time.go`

Implementation:

- add a helper that attempts to parse an absolute timestamp or date from `raw.SourceSection`
- if a parsed value exists and `mem.Metadata.TimestampStart` is empty, populate it
- do not overwrite explicitly provided metadata

Expected result:

- imported transcript memories get normalized session anchors in metadata
- FTS immediately benefits because `BuildMetadataPrefix()` already emits `date:YYYY-MM-DD`

#### 2. Expose the anchor date in answer context

Target files:

- `internal/answer/engine.go`
- `internal/reason/engine.go`
- `internal/reason/recursive.go`

Implementation:

- when rendering each retrieved result for the reader, append one short normalized line when present:

```text
anchor_date: 2023-03-23
```

- keep the original `SourceSection` text too
- do not attempt date reasoning yet; only expose the anchor explicitly

Expected result:

- the reader sees both relative language and the absolute session date in the same block
- this should reduce “last week” / “not mentioned” failures on temporal questions

#### 3. Optional but still small: include the normalized date in embedding enrichment text

Target files:

- `internal/store/context.go`
- `internal/ingest/embed.go`

Implementation:

- extend the embedding prefix to include a compact normalized token when metadata has `TimestampStart`
- example:

```text
[conv-30 > Session 7 - 7:28 pm on 23 March, 2023 > date:2023-03-23]
```

This is optional for the first patch. The minimal viable version is still useful without it because FTS and answer prompts already improve.

### Non-Goals for Phase 1

- no relative-date resolver yet
- no new fact type
- no change to the current deny rule for specific temporal facts at ingest

### Tests

Add unit tests for:

- source-section date parsing
- ingest preserving explicit metadata while filling missing `TimestampStart`
- answer context rendering includes `anchor_date`
- metadata FTS prefix includes normalized date for transcript memories

Suggested files:

- `internal/ingest/source_section_time_test.go`
- `internal/ingest/ingest_test.go`
- `internal/answer/engine_test.go`
- `internal/store/metadata_test.go`

### Success Criteria

- no regressions in existing ingest tests
- no new migration required
- LoCoMo category 2 does not regress on retrieval hit rate
- target benchmark gain:
  category 2 answer quality improves by at least `+5` points on the `conv-30` slice

### Go / No-Go Gate

Go if:

- the patch is small and low-risk
- category 2 improves without hurting category 4

No-go if:

- improvement is less than `+3` points and the reader still mostly outputs relative phrases

If no-go, add a deterministic relative-date resolver as a follow-up before starting the planner.

## Phase 2: Multi-Hop Search Planner MVP

### Goal

Improve category 3 and “shared/commonality” questions without turning Cortex search into a free-form agent loop.

### Product Shape

Add a bounded planner mode to search and answer:

```bash
cortex search "<query>" --mode hybrid --planner multihop
cortex answer "<query>" --mode hybrid --planner multihop
```

Default behavior stays unchanged unless the planner is explicitly enabled.

### Planner Principles

- deterministic first
- bounded fan-out
- no recursive LLM loop in the MVP
- build evidence sets, not just alternative single queries

### Proposed API

Target file:

- `internal/search/search.go`

Add:

```go
type PlannerMode string

const (
  PlannerNone     PlannerMode = ""
  PlannerMultiHop PlannerMode = "multihop"
)

type Options struct {
  ...
  Planner PlannerMode
}
```

Add a planner entry point:

```go
func (e *Engine) searchWithPlanner(ctx context.Context, query string, opts Options) ([]Result, error)
```

### New Planner Package

Target files:

- new package directory: `internal/search/planner/`
- suggested files:
  - `planner.go`
  - `detect.go`
  - `subqueries.go`
  - `evidence.go`

### Planner Flow

#### Step 1. Detect whether the query is worth planning

Use cheap heuristics only.

Good triggers:

- `both`
- `have in common`
- `why did`
- `likely`
- `what fields`
- `how do X and Y`
- `what do X and Y`
- `after`
- `before`
- `when did X ... after ...`

If no trigger hits, fall back immediately to normal search.

#### Step 2. Extract slots

Pull out:

- entities
- bridge predicates
- expected answer type

Examples:

- `What do Jon and Gina both have in common?`
  entities = `Jon`, `Gina`
  bridge = `shared attribute`

- `What fields would Caroline be likely to pursue?`
  entity = `Caroline`
  bridge = `education`, `career`, `counseling`, `psychology`

#### Step 3. Generate bounded subqueries

Use at most 4 searches:

1. original query
2. entity A focused query
3. entity B focused query
4. bridge query

Also allow one `SearchFacts` call for exact subject/predicate support.

#### Step 4. Run subqueries in parallel

Reuse the existing engine:

- `Search(...)`
- `SearchFacts(...)`
- existing `--expand` logic if useful, but cap total search count

#### Step 5. Build evidence bundles

Create in-memory bundles keyed by:

- `memory_id`
- `source_section`
- `fact_id`
- covered entities
- covered bridge terms
- temporal anchor, if any

#### Step 6. Re-rank by coverage

The important change is here.

Current hybrid ranking is per-result. The planner should re-rank evidence sets by:

- entity coverage
- bridge coverage
- fact support
- temporal support
- original search score

Suggested first-pass scoring:

```text
bundle_score =
  0.40 * max_base_relevance +
  0.30 * entity_coverage +
  0.20 * bridge_coverage +
  0.10 * fact_support
```

#### Step 7. Return grouped results

For `search`, flatten the winning bundle into ordered results.

For `answer`, pass grouped evidence blocks:

```text
Hop A evidence
Hop B evidence
Bridge evidence
```

That is more useful than five unstructured chunks.

### CLI Integration

Target file:

- `cmd/cortex/main.go`

Changes:

- add `--planner multihop`
- plumb it into both `runSearch` and `runAnswer`
- keep default planner empty

### Explainability

Target file:

- `internal/search/search.go`

If `--explain` is enabled, append planner provenance:

- planner triggered or not
- trigger reason
- generated subqueries
- winning evidence bundle coverage

This matters because otherwise the planner will look like hidden ranking magic.

### Tests

Add deterministic planner tests with synthetic memories:

- shared-attribute question
- two-hop causal question
- multi-hop temporal question
- non-planner query should fall back with identical results

Suggested files:

- `internal/search/planner/planner_test.go`
- `internal/search/search_test.go`
- `cmd/cortex/main_test.go`

### Success Criteria

- no regression for normal `search` without planner
- planner adds no more than 4 search calls plus 1 fact search
- target benchmark gain:
  - category 3 top-5 evidence hit from `54.17%` to at least `65%`
  - category 1 shared/commonality questions improve on the `conv-30` slice

### Go / No-Go Gate

Go if:

- planner improves category 3 by `>= 8` points
- non-planner latency and ranking remain unchanged

No-go if:

- planner helps only synthetic tests but not the LoCoMo slice
- planner mostly duplicates current `--expand` behavior without evidence-set gains

## Phase 3: Only If Needed

If Phase 1 does not move temporal questions enough, add a deterministic relative-date resolver.

### Shape

New helper:

- `internal/temporal/resolve.go`

Inputs:

- anchor date
- phrase like `last week`, `Sunday`, `4 years ago`

Outputs:

- normalized date or normalized date range string

Use it only in:

- answer context rendering
- planner evidence summaries

Do not put it into generic fact extraction in the first pass.

## Review Checklist

The reviewing agent should answer these directly:

1. Is the Phase 1 temporal patch small enough to land before the planner?
2. Is `--planner multihop` the right surface, or should this be answer-only first?
3. Should planner evidence bundling live inside `internal/search` or under `internal/reason`?
4. Is the score function above sufficient for MVP, or does it need stronger fact weighting?
5. Is the optional embedding-date prefix worth including in Phase 1, or should it wait?

## Recommended Order

1. Phase 1 without embedding-prefix changes
2. benchmark rerun
3. planner MVP behind flag
4. benchmark rerun
5. optional temporal resolver only if Phase 1 underperforms

## Bottom Line

The minimum useful temporal fix is:

- parse session date from `SourceSection`
- store it in `Metadata.TimestampStart`
- surface `anchor_date` in answer context

The minimum useful multi-hop planner is:

- heuristic trigger
- 3-4 bounded subqueries
- evidence-bundle reranking by slot coverage
- explicit flag-gated rollout

That is the plan I recommend shipping.
