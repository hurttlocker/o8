# Cortex Multi-Hop + Temporal Implementation Plan

## Goal

Turn the two biggest LoCoMo gaps into shippable Cortex work:

1. temporal reasoning
2. multi-hop retrieval/planning

This doc is an implementation spec. It answers:

- where the fixes belong in the pipeline
- the minimum schema changes
- command/API shape
- stop conditions and budgets
- quick wins that can ship before the bigger work

## Benchmark Context

From the current Cortex LoCoMo run:

- Category 2 temporal:
  - hybrid top-5 evidence hit `75.08%`
  - hybrid evidence recall `72.79%`
  - hybrid + reader F1 `23.09%`
  - hybrid + reader exact match `2.80%`
- Category 3 multi-hop:
  - hybrid top-5 evidence hit `54.17%`
  - hybrid evidence recall `46.70%`
  - hybrid + reader F1 `8.01%`
  - hybrid + reader exact match `0.00%`

Interpretation:

- temporal retrieval is not the main problem; normalization/composition is
- multi-hop is both a retrieval and a composition failure

## Effort Scale

- `S`: 0.5-1.5 engineering days
- `M`: 2-5 engineering days
- `L`: 1-2 engineering weeks

## Current Cortex Touch Points

These are the main code seams this plan assumes in the upstream Cortex repo:

- `internal/ingest/ingest.go`
  constructs `store.Memory` during import
- `internal/store/store.go`
  already has `Metadata.TimestampStart`
- `internal/store/metadata.go`
  already adds `date:YYYY-MM-DD` to the FTS metadata prefix when `TimestampStart` exists
- `internal/store/context.go`
  builds the embedding prefix
- `internal/search/search.go`
  owns BM25 / semantic / hybrid / RRF search
- `internal/search/expand.go`
  already supports multi-query expansion
- `internal/answer/engine.go`
  builds answer context and calls the reader model
- `internal/reason/recursive.go`
  already implements a bounded search-again loop
- `internal/extract/llm_client.go`
  defines the base extraction prompt/schema
- `internal/extract/enrich.go`
  defines the enrichment prompt/schema

## 1. Temporal Reasoning Fix

## Recommendation

Date normalization should happen in both places:

- import time:
  persist canonical temporal structure on evidence
- query time:
  normalize the user question and use the same canonical structure for ranking and rendering

If only one can ship first, ship import-time normalization first. That is where the largest gap is today.

## Why Cortex Is Missing Temporal Questions

The benchmark failures are mostly not “could not retrieve the session”.
They are “retrieved a chunk containing `last week`, `next month`, `Sunday`, `4 years ago`, or `the week before June 9`, but never turned it into the expected date form.”

Right now Cortex effectively stores:

- literal section/date strings in `SourceSection`
- literal temporal text in chunk content
- no canonical temporal form on the fact itself

That means the reader has to infer date arithmetic from noisy transcript snippets. It often fails.

## Pipeline Placement

### Import-time normalization

Import-time normalization should happen in two layers.

#### Layer A: memory/session anchor

Target:

- `internal/ingest/ingest.go`
- new helper: `internal/ingest/source_section_time.go`

Action:

- parse `raw.SourceSection` for an absolute date/time
- if found, populate `mem.Metadata.TimestampStart`
- only fill it when metadata does not already provide `TimestampStart`

This is the lowest-risk win because:

- the metadata field already exists
- FTS already knows how to index it via `BuildMetadataPrefix()`
- no schema migration is required for this piece

#### Layer B: fact-level temporal normalization

Target:

- `internal/extract/extract.go`
- `internal/extract/llm_client.go`
- `internal/extract/enrich.go`
- `internal/ingest/StoreExtractedFact` path

Action:

- whenever a fact is `FactType == temporal`, run a deterministic normalizer
- the normalizer consumes:
  - literal temporal phrase
  - memory anchor date from `Metadata.TimestampStart`
  - optionally `SourceSection` when metadata anchor is missing
- persist the normalized result next to the fact

This is the piece that actually closes the benchmark gap.

### Query-time normalization

Target:

- `internal/search/search.go`
- `internal/answer/engine.go`
- `internal/reason/recursive.go`

Action:

- parse temporal phrases in the query into a canonical query-time temporal hint
- use the hint to:
  - boost exact or overlapping temporal evidence
  - render normalized time in answer context

This should be ranking-sensitive, not hard-filtered by default. Hard filtering will be too brittle on partial transcript imports and vague user questions.

## Normalized Temporal Representation

## Minimum schema change

Add one nullable JSON column to `facts`:

```sql
ALTER TABLE facts ADD COLUMN temporal_norm TEXT NULL;
```

That is the minimum schema change worth making.

Why a JSON blob instead of multiple new columns:

- lower migration cost
- easier to evolve from date to date-range or duration
- easier to preserve both literal and normalized representations

Do not replace `facts.object`.
Keep the literal phrasing in `object`, because:

- source fidelity matters
- the same phrase may need re-resolution later
- some UI/debug surfaces should still show the original text

## JSON shape

Suggested shape:

```json
{
  "kind": "date_range",
  "literal": "the week before June 9",
  "anchor": "2023-06-09",
  "start": "2023-06-02",
  "end": "2023-06-08",
  "precision": "day",
  "resolution": "resolved_from_anchor",
  "calendar_ref": "session_start",
  "confidence": 0.93
}
```

For other cases:

- absolute day:
  - `kind = "date"`
  - `value = "2023-05-07"`
- month/year:
  - `kind = "date_range"`
  - `start = "2023-06-01"`
  - `end = "2023-06-30"`
  - `precision = "month"`
- duration:
  - `kind = "duration"`
  - `amount = 4`
  - `unit = "year"`
- unresolved:
  - `resolution = "unresolved"`
  - `anchor = null`

## Go structs

Add to `store.Fact`:

```go
type TemporalNorm struct {
    Kind       string  `json:"kind"`
    Literal    string  `json:"literal"`
    Value      string  `json:"value,omitempty"`
    Start      string  `json:"start,omitempty"`
    End        string  `json:"end,omitempty"`
    Anchor     string  `json:"anchor,omitempty"`
    Precision  string  `json:"precision,omitempty"`
    Resolution string  `json:"resolution,omitempty"`
    CalendarRef string `json:"calendar_ref,omitempty"`
    Confidence float64 `json:"confidence,omitempty"`
}

type Fact struct {
    ...
    TemporalNorm *TemporalNorm
}
```

Persist it as `temporal_norm TEXT`.

## Relative date handling

## Rule

Relative dates are resolved against the session anchor, not “now”.

That means:

- `last week` in session dated `2023-06-09` resolves relative to `2023-06-09`
- `next month` in session dated `2023-05-08` resolves relative to `2023-05-08`
- `4 years ago` in a session dated `2023-07-12` resolves to around `2019-07`

This is exactly what transcript-style benchmarks need.

## Fallback order

When resolving a temporal phrase:

1. use `memory.Metadata.TimestampStart`
2. if empty, parse `memory.SourceSection`
3. if still empty, leave `temporal_norm` unresolved

Do not resolve relative dates against import time.
That would poison benchmark and production correctness.

## Minimal extraction prompt change

Rule extraction is deterministic, so prompt changes are only needed for the LLM extraction/enrichment paths.

### Base extraction prompt

Target:

- `internal/extract/llm_client.go`

Change the schema from:

```json
{
  "subject": "...",
  "predicate": "...",
  "object": "...",
  "type": "temporal",
  "confidence": 0.85,
  "source_quote": "..."
}
```

to:

```json
{
  "subject": "...",
  "predicate": "...",
  "object": "...",
  "type": "temporal",
  "confidence": 0.85,
  "source_quote": "...",
  "temporal_norm": {
    "kind": "date|date_range|duration",
    "literal": "exact temporal phrase",
    "value": "YYYY-MM-DD if exact",
    "start": "YYYY-MM-DD if range",
    "end": "YYYY-MM-DD if range",
    "precision": "day|week|month|year",
    "resolution": "absolute|resolved_from_anchor|unresolved"
  }
}
```

Prompt rule:

- if the text uses relative time, preserve the literal in `object` and resolve `temporal_norm` using the provided anchor date
- if the anchor is unavailable, set `resolution = "unresolved"`

### Enrichment prompt

Target:

- `internal/extract/enrich.go`

Same schema addition.
The system prompt should explicitly say:

- temporal facts must return both the literal phrase and a canonical normalized form when possible
- canonical form must use the supplied chunk/session anchor, not today’s date

## Query-time spec

Add a lightweight query temporal parser:

```go
type TemporalQuery struct {
    Raw        string
    Kind       string
    Value      string
    Start      string
    End        string
    Precision  string
    Resolved   bool
}
```

Add to `search.Options`:

```go
type Options struct {
    ...
    QueryTime *TemporalQuery
}
```

Behavior:

- if query has an explicit date or relative-time phrase, parse it
- use it to boost facts/memories whose `TemporalNorm` overlaps
- do not hard-filter unless the caller explicitly requests strict temporal filtering later

## Answer rendering change

When building answer context, append normalized temporal information:

```text
source_section: Session 7 - 7:28 pm on 23 March, 2023
anchor_date: 2023-03-23
temporal_norm: 2023-03-02..2023-03-08
```

This is critical because the reader often sees “last week” but never sees the canonical date range.

## Rollout plan

### Temporal Phase A

- populate `TimestampStart` from `SourceSection`
- expose `anchor_date` in answer context

Effort: `S`

Expected gain:

- category 2 F1: `+4` to `+7` absolute
- category 2 exact match: `+3` to `+6` absolute

### Temporal Phase B

- add `facts.temporal_norm`
- normalize rule and LLM temporal facts at import time
- add query-time temporal boosts

Effort: `M`

Expected gain:

- category 2 F1: additional `+6` to `+10` absolute
- category 2 exact match: additional `+5` to `+9` absolute

### Combined estimate

On the full LoCoMo slice:

- category 2 F1 from `23.09%` to roughly `33-40%`
- category 2 exact match from `2.80%` to roughly `10-16%`

This estimate assumes:

- no change to the reader model
- current retrieval quality stays flat or improves slightly
- the answer context exposes normalized forms cleanly

## 2. Multi-Hop Search Planner

## Recommendation

Put the planner in the Cortex binary, not in a wrapper or IDE layer.

Primary surface:

```bash
cortex answer "<query>" --plan multihop
```

Diagnostic/debug surface:

```bash
cortex search "<query>" --planner multihop --json
```

Reason:

- `answer` is the product surface that benefits most
- `search` still needs planner visibility for IDEs, tests, and explainability
- if it only exists in an IDE wrapper, benchmark reproducibility and CLI parity get worse

## New command/API shape

### CLI

Add:

- `cortex answer "<query>" --plan multihop`
- `cortex search "<query>" --planner multihop`

Do not add `--multi-hop` as a bare boolean.
Use an enum-like value now so you can add `temporal`, `agentic`, or `none` later.

### Search options

Add to `search.Options`:

```go
type PlannerMode string

const (
    PlannerNone     PlannerMode = ""
    PlannerMultiHop PlannerMode = "multihop"
)

type Options struct {
    ...
    Planner PlannerMode
    HopLimit int
    RetrievalBudget time.Duration
}
```

## Planner architecture

### Package layout

Recommended:

- `internal/search/planner/`
  - `planner.go`
  - `detect.go`
  - `reformulate.go`
  - `evidence.go`
  - `stop.go`

Reason:

- planner is retrieval logic, not answer rendering
- `answer` should consume the planner, not own it

### Execution model

The planner is deterministic in the MVP.
No LLM calls per hop.

Flow:

1. detect if planning is needed
2. run initial search
3. extract entities / missing slots from top evidence
4. formulate refinement queries
5. run second hop
6. merge evidence into bundles
7. stop or do one more hop
8. hand evidence bundle to answer synthesis

## Concrete reformulation loop

### Hop 0: initial retrieval

Input:

- original question

Call:

- `Search(query, opts)` using `hybrid` or `rrf`
- `SearchFacts(query, opts)` optionally for entity/predicate anchors

Output:

- top memory results
- top fact results
- extracted slot coverage state

### Coverage state

Create a planner state:

```go
type CoverageState struct {
    EntitiesWanted   []string
    EntitiesFound    map[string]bool
    BridgeTermsWanted []string
    BridgeTermsFound  map[string]bool
    TemporalWanted   *TemporalQuery
    TemporalCovered  bool
    EvidenceBundles  []EvidenceBundle
}
```

### Hop 1: refinement

From the top results, derive missing coverage.

Examples:

- question: `What do Jon and Gina both have in common?`
  - if Jon evidence exists but Gina evidence is weak:
    - refinement query: `Gina lost job started business`
  - if both exist but bridge is weak:
    - refinement query: `Jon Gina both lost jobs started businesses`

- question: `What fields would Caroline be likely to pursue?`
  - refinement query:
    - `Caroline psychology counseling certification education`

### Hop 2: bridge/composition query

Only if needed.

The second refinement should try to force intersection:

- entity A + bridge
- entity B + bridge
- intersection query

Example generated query set for a 2-hop planner:

```text
Hop 0: What do Jon and Gina both have in common
Hop 1A: Jon lost job started business
Hop 1B: Gina lost job started business
Hop 2: Jon Gina both lost jobs started businesses
```

## Default hops and budget

### Default hops

- default: `2`
- max: `3`

Why:

- benchmark data does not justify deeper chains
- current hybrid latency is too expensive for open-ended loops

### Latency budget

Defaults:

- retrieval budget: `8s`
- total answer budget: `10s`

Interpretation:

- if the planner uses BM25 only, it will usually finish well under budget
- if it uses hybrid, it should get at most two retrieval rounds plus one final answer call

This matches the measured environment:

- current hybrid retrieval averages about `4.1s`
- current answer synthesis averages about `0.67s`

A reasonable two-hop hybrid plan therefore lands around `8.5-9.5s`.

## Stop conditions

The planner should stop when any of these are true:

1. all required entities are covered
2. bridge coverage is satisfied
3. temporal constraint is satisfied, if any
4. latest hop adds no new entities, facts, or bundles above a relevance floor
5. retrieval budget is exhausted
6. hop limit is exhausted

### Enough-evidence rule

Use a deterministic threshold, not an LLM judgment.

Example:

```go
stop if:
  entity_coverage == 1.0 &&
  bridge_coverage >= 0.8 &&
  best_bundle.score >= 0.72
```

For temporal questions:

```go
stop if:
  temporal_coverage == true &&
  best_bundle has at least one normalized temporal fact
```

## Evidence bundle model

This is the core planner output.

```go
type EvidenceBundle struct {
    MemoryIDs      []int64
    FactIDs        []int64
    SourceSections []string
    Entities       []string
    BridgeTerms    []string
    Temporal       *store.TemporalNorm
    BaseScore      float64
    CoverageScore  float64
    FinalScore     float64
}
```

### Bundle scoring

Suggested first version:

```text
final_score =
  0.35 * max_result_score +
  0.25 * entity_coverage +
  0.20 * bridge_coverage +
  0.10 * fact_support +
  0.10 * temporal_support
```

This is intentionally simple and testable.

## LLM calls per hop

### MVP

Zero LLM calls per hop.

Use:

- deterministic trigger detection
- deterministic slot extraction from question text + top fact snippets
- deterministic reformulation templates

The only LLM call in the MVP `answer --plan` flow should be the final synthesis call.

This is the right first version because:

- Cortex already suffers from retrieval latency
- an LLM planner per hop would make worst-case latency explode
- the benchmark gaps are structural enough that deterministic reformulation should already help

### Optional v2

If deterministic reformulation underperforms, add one optional planner call up front:

- 1 planner LLM call before hop 1
- 1 final answer LLM call after evidence is gathered

Still do not call the LLM every hop.

## Token cost estimate for a typical 2-hop query

### MVP deterministic planner

- planner calls: `0`
- final answer call only:
  - input: `2,000-4,000` tokens
  - output: `80-180` tokens

So the incremental token cost versus today is almost zero.

### Optional v2 LLM-assisted planner

- planner call:
  - input: `400-900` tokens
  - output: `100-220` tokens
- final answer call:
  - input: `2,000-4,000` tokens
  - output: `80-180` tokens

Typical total:

- input: `2.4k-4.9k`
- output: `180-400`

This is acceptable, but not needed for MVP.

## Estimated score impact

### Planner-only estimate

If the deterministic planner ships without a stronger reader:

- category 3 top-5 evidence hit:
  - from `54.17%`
  - to `65-72%`
- category 3 evidence recall:
  - from `46.70%`
  - to `58-66%`
- category 3 F1:
  - from `8.01%`
  - to `18-28%`

The F1 range is wide because the current reader is still weak.

### Planner plus better evidence rendering

If the planner also passes grouped evidence blocks to the answer model:

- category 3 F1 could plausibly reach `22-32%`

That still will not match top vendors, but it is enough to move Cortex out of the collapse zone.

### Effort

- deterministic planner MVP in binary: `L`
- answer integration and explainability: `M`
- optional LLM-assisted planner v2: `M`

## 3. Quick Wins

These are worth doing before or alongside the bigger work.

## Quick Win A: FTS query sanitization

### Problem

Current `sanitizeFTSQuery()` in `internal/search/search.go` is effectively just:

```go
return strings.TrimSpace(query)
```

That means malformed quotes and operator-like punctuation still reach FTS and sometimes fail.

### Spec

Replace it with a real sanitizer:

- preserve balanced quoted phrases
- strip or escape unmatched quotes
- remove raw `AND`, `OR`, `NOT` unless explicitly intended
- normalize punctuation to spaces
- if the original query contains suspicious syntax, proactively run `escapeFTSQuery()`

### Target files

- `internal/search/search.go`
- `internal/search/search_test.go`

### Effort

- `S`

### Expected impact

- benchmark stability improvement, not a large score jump
- likely `+0` to `+2` score points
- important because it removes silent hard failures

## Quick Win B: `cortex answer` hybrid mode fix

### Problem

`runSearch` auto-resolves the embedder from config/env for hybrid mode.
`runAnswer` does not. It always constructs `search.NewEngine(s)` with no embedder, so `answer --mode hybrid` degrades.

### Spec

Mirror the embedder setup from `runSearch` inside `runAnswer`.

Changes:

- add `--embed <provider/model>` support to `cortex answer`
- auto-resolve embedder from config/env when mode is `hybrid`, `rrf`, or `semantic`
- build HNSW the same way `runSearch` does

### Target files

- `cmd/cortex/main.go`
- `internal/answer/engine.go`
- `cmd/cortex/main_test.go`

### Effort

- `S`

### Expected impact

- not necessarily a benchmark score jump by itself
- but it removes a broken code path and makes the answer CLI usable for real evaluation

## Quick Win C: Retrieval tuning before code-heavy planner work

### No-code tuning

For benchmark-style QA, try:

```bash
cortex search "<query>" --mode rrf --limit 8 --expand
```

Rationale:

- RRF often preserves exact lexical hits better than the current weighted hybrid blend
- `limit 8` gives the reader more evidence for multi-hop questions
- `--expand` is a cheap bridge until a real planner exists

### Small-code tuning

Current hybrid blend is semantic-heavy:

- `hybridAlpha = 0.3`

For exact-detail QA, test:

- `hybridAlpha = 0.45`
- or a separate QA profile:
  - candidate pool `limit * 5`
  - RRF by default
  - answer limit `8`

### Target files

- `internal/search/search.go`
- `cmd/cortex/main.go`

### Effort

- no-code preset: `S`
- QA profile or alpha retuning: `S-M`

### Expected impact

- category 1 and category 3 answer-hit gains of roughly `+2` to `+5` points
- little or no help for true temporal normalization

## Recommended Rollout Order

1. Quick Win B: `cortex answer` hybrid fix
2. Quick Win A: FTS sanitization
3. Temporal Phase A
4. benchmark rerun
5. Temporal Phase B
6. benchmark rerun
7. deterministic multi-hop planner MVP
8. benchmark rerun
9. optional LLM-assisted planner only if deterministic planner underperforms

## Bottom Line

If the goal is fastest score improvement:

- ship the temporal anchor + normalization work first

If the goal is highest leverage architecture change:

- build the planner in the binary, but keep the MVP deterministic and bounded

The smallest set of changes I would actually approve right now is:

1. fix `cortex answer` hybrid embedder setup
2. fix FTS query sanitization
3. populate `TimestampStart` from transcript sections
4. add `facts.temporal_norm`
5. add `cortex answer --plan multihop` with a deterministic 2-hop planner

That is the shortest path to materially better LoCoMo behavior without overdesigning the system.
