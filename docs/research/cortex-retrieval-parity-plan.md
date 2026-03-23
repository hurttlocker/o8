# Cortex Retrieval Parity Plan

## Purpose

This is the concrete plan to close the retrieval-shape gap between Cortex and SuperLocalMemory-style LoCoMo systems without mixing benchmark-scoring changes into retrieval work.

It turns the current recommendation into an execution sequence:

1. scorer parity first
2. query strategy classification
3. weighted RRF across real retrieval channels
4. scene expansion and bridge discovery
5. deeper graph traversal only after the above

This is a reviewable implementation plan, not a speculative note.

## Why This Exists

From the existing Cortex benchmark and SLM audit:

- Cortex currently uses a smaller retrieval stack than the strongest public LoCoMo systems.
- Cortex still treats many query shapes too uniformly.
- The public SLM materials show a retrieval path of:

`query -> strategy classifier -> 4 parallel channels -> weighted RRF -> scene expansion -> bridge discovery -> cross-encoder rerank -> top-k`

- Cortex already has pieces of this, but not the full stack in production:
  - BM25
  - semantic retrieval
  - hybrid / optional RRF
  - entity graph retrieval
  - temporal normalization and boosting
  - local reranking

The missing pieces are not abstract. They are mostly routing, fusion, and evidence expansion.

## Important Constraint

Do not move the benchmark goalposts during the same implementation cycle.

The existing research setup already calls for an immutable evaluator. That means:

- keep the current LoCoMo F1 / EM harness unchanged
- add scorer-parity outputs beside it
- do not replace the headline metric while retrieval work is landing

This matters because published SLM numbers appear accuracy-like, while Cortex's documented runs use token F1 / EM. That metric mismatch may change the apparent gap, but it does not remove the retrieval/composition gap already visible in Cortex's own category-level failures.

## Recommendation

Recommended execution order:

1. add scorer parity reporting
2. add a lightweight query strategy classifier
3. ship weighted RRF with per-strategy channel weights
4. add scene expansion
5. add bridge discovery
6. only then evaluate whether deeper entity-graph spreading is still needed

Do not start with 3-hop graph traversal.

That is the highest-noise part of the proposed stack, and it depends on classifier quality, canonical entities, and better fusion already being in place.

## Current Cortex Seams

Relevant files in the `hurttlocker/cortex` repo:

- `internal/search/search.go`
  owns channel retrieval, hybrid search, and reranking handoff
- `internal/search/rrf.go`
  existing RRF support and the most obvious fusion seam
- `internal/entity/*`
  entity extraction / graph primitives
- `internal/temporal/*`
  temporal normalization and query-time temporal helpers
- `internal/ask/engine.go`
  answer synthesis path used by the current best benchmark route
- `cmd/cortex/main.go`
  CLI surfacing for retrieval options and future debug flags

## Phase 0: Scorer Parity

### Goal

Make Cortex benchmark outputs directly comparable to SLM-style published numbers without corrupting the existing F1 benchmark history.

### Deliverable

Add a second scorer output next to the current F1 / EM metrics:

- `token_f1`
- `set_em`
- `normalized_accuracy`

### Implementation

Keep the current scorer untouched.

Add a second scorer module that:

- lowercases and trims answers
- strips punctuation-only differences
- normalizes common date spellings
- normalizes list separators
- compares the final normalized answer string against normalized gold aliases

Suggested Cortex benchmark changes:

- add `scripts/bench/score_normalized.go`
- add a result schema field in the benchmark JSON:

```json
{
  "token_f1": 0.42,
  "set_em": 0,
  "normalized_accuracy": 1
}
```

- emit aggregate summaries for all three metrics

### Acceptance

- historical F1 / EM numbers remain reproducible
- every benchmark run now reports normalized accuracy beside F1
- the report explicitly calls out that normalized accuracy is the apples-to-apples comparison metric for SLM-style public claims

### Effort

`S`

## Phase 1: Query Strategy Classifier

### Goal

Stop treating every query as the same retrieval problem.

### Why First

Weighted fusion is only useful if the system knows when to trust BM25, semantic, entity, or temporal retrieval more heavily.

### Output Shape

Introduce a small strategy type:

```go
type QueryStrategy string

const (
  StrategyDefault    QueryStrategy = "default"
  StrategyTemporal   QueryStrategy = "temporal"
  StrategyEntity     QueryStrategy = "entity"
  StrategyComparison QueryStrategy = "comparison"
  StrategyBridge     QueryStrategy = "bridge"
)
```

### Initial Implementation

Use deterministic heuristics first, not an LLM classifier.

Suggested new file:

- `internal/search/strategy.go`

Rules:

- temporal:
  - `when`
  - `what date`
  - `what day`
  - `last week`
  - `before`
  - `after`
  - `the week before`
- entity:
  - `who is`
  - `what does <name>`
  - `where does <name>`
- comparison:
  - `both`
  - `in common`
  - `same`
  - `different`
- bridge:
  - `why`
  - `how did`
  - `what happened after`
  - queries mentioning 2+ named entities plus a relation

Return:

- strategy label
- extracted entities
- temporal hint if present
- whether scene expansion should be enabled

### Acceptance

- classifier logs are inspectable in debug output
- at least `90%` of the known LoCoMo temporal questions route to temporal strategy
- comparison/commonality questions no longer default to the same weights as single-hop factual questions

### Effort

`S`

## Phase 2: Weighted RRF Across Four Channels

### Goal

Replace naive hybrid blending with explicit fusion across independent candidate channels.

### Channels

1. BM25
2. semantic
3. entity graph
4. temporal

### Required Change

Run the four channels independently and fuse their ranks with weighted RRF.

Suggested formula:

```text
score(doc) = sum_i weight_i(strategy) * 1 / (k + rank_i(doc))
```

Defaults:

- `k = 60`

Example starting weights:

| Strategy | BM25 | Semantic | Entity | Temporal |
| --- | ---: | ---: | ---: | ---: |
| default | 1.0 | 1.0 | 0.6 | 0.4 |
| temporal | 0.7 | 0.8 | 0.3 | 1.4 |
| entity | 0.7 | 0.8 | 1.4 | 0.3 |
| comparison | 0.8 | 1.0 | 1.2 | 0.4 |
| bridge | 0.9 | 1.1 | 1.0 | 0.7 |

### Implementation Seams

- extend `internal/search/rrf.go`
- add strategy-aware weight selection in `internal/search/search.go`
- add channel-level debug output:
  - retrieved ranks per channel
  - fused score
  - final selected top-k

### Acceptance

- every search result can explain which channels contributed to its fused score
- `--debug-search` shows the per-channel ranking table
- weighted RRF beats or matches current hybrid on the broad slice before scene expansion is added

### Effort

`M`

## Phase 3: Scene Expansion

### Goal

Stop returning isolated chunks when the answer depends on adjacent turns in the same conversation scene.

### What Scene Expansion Means Here

Given a fused top hit, pull adjacent turns or nearby chunks from the same session if they are likely to contain supporting evidence.

This is not full agentic retrieval. It is bounded local neighborhood expansion.

### Initial Implementation

Suggested new file:

- `internal/search/scene.go`

Algorithm:

1. take top `N=5` fused seeds
2. for each seed, fetch adjacent chunks from the same memory / session:
   - previous chunk
   - next chunk
   - optionally one more hop if the seed contains a dialogue boundary
3. rescore neighbors with:
   - lexical overlap with query
   - shared entities with the seed
   - temporal consistency with the query anchor
4. merge them into a scene bundle

Each returned result should carry:

- `seed_result`
- `scene_neighbors`
- `scene_score`

### Acceptance

- scene expansion increases evidence recall on comparison and open-domain questions
- the answer prompt can see grouped local context instead of unrelated flat chunks
- latency increase stays under a fixed budget, initially `<= 300 ms` retrieval-side

### Effort

`M`

## Phase 4: Bridge Discovery

### Goal

Find the second piece of evidence needed for multi-evidence questions without invoking a planner loop.

### What Counts As A Bridge

A bridge is a result that does one of these:

- covers a missing entity from the query
- shares an entity with a seed but contributes a different predicate
- links two candidate scenes through a common entity, date, or event

### Initial Implementation

Suggested new file:

- `internal/search/bridge.go`

Algorithm:

1. inspect the current fused top results and extracted query entities
2. compute coverage gaps:
   - missing entities
   - missing temporal support
   - missing comparison/shared-attribute support
3. issue one bounded bridge retrieval per gap:
   - `entity + predicate`
   - `entity A + entity B`
   - `entity + normalized date`
4. merge bridge hits into the result pool with a bridge bonus, then rerank

Bridge discovery should stay deterministic:

- max `2` bridge queries
- max `10` bridge candidates each
- no LLM calls

### Acceptance

- comparison questions more often return evidence sets that cover both entities
- bridge retrieval is logged and explainable
- category `3` or commonality-style slices improve without large regressions on broad slices

### Effort

`M`

## Phase 5: Graph Traversal Only If Still Needed

### Goal

Upgrade the entity graph from direct lookup to spreading activation only after the lower-risk retrieval fixes land.

### Why Later

3-hop traversal on noisy entities can easily overwhelm the pool with weak graph-adjacent candidates.

If classifier + weighted RRF + scene expansion + bridge discovery are working, the residual need for deep graph traversal may be much smaller.

### Initial Implementation

Add bounded traversal settings:

- default `1` hop
- experimental `3` hops only behind a flag
- edge-type weights
- decay by hop count

Suggested score:

```text
graph_score = edge_weight * node_confidence * hop_decay
```

with:

- `hop_decay = 1.0, 0.55, 0.30`

### Acceptance

- 3-hop traversal must improve targeted entity/commonality slices before it is enabled by default
- if it only helps narrow slices and harms broad precision, keep it opt-in

### Effort

`M`

## Benchmark Protocol

### Rule

Do not change retrieval and scoring methodology in the same keep/discard decision.

### Required Runs

For each landed phase:

1. run the current frozen F1 / EM harness
2. run the added normalized-accuracy scorer
3. record category-level results
4. keep the same corpus and answer slice

### Required Slices

Do not rely only on the public `conv-30` 81-question slice if it excludes category `3`.

Use:

- the current comparable `conv-30` slice for continuity
- a targeted multi-hop / comparison slice that actually exercises category `3`
- a temporal slice for category `2`

### Reporting Format

Every benchmark note should show:

- retrieval mode
- token F1
- exact match
- normalized accuracy
- degraded count
- average latency
- category breakdown

## SLM Harness Parity

If the SLM repo or scorer harness is available locally later:

1. run Cortex outputs through the SLM-compatible scorer
2. keep the native Cortex F1 harness unchanged
3. publish both tables in the same note

Do not block the retrieval work on access to that harness.

At the time of this plan, the referenced `superlocalmemory` checkout was not present in the local workspace, and the earlier audit did not find a public full LoCoMo harness in the audited public repo snapshot.

## Proposed Landing Order

### Phase 1

- scorer parity
- query strategy classifier

Why:

- smallest work
- highest information value
- minimal product risk

### Phase 2

- weighted RRF
- per-strategy channel weights

Why:

- immediate retrieval-shape improvement
- uses channels Cortex already has

### Phase 3

- scene expansion
- grouped evidence rendering in the answer path

Why:

- best low-risk path to multi-evidence answers without agentic loops

### Phase 4

- bridge discovery

Why:

- composition gain after better candidate pools exist

### Phase 5

- optional deeper graph traversal

Why:

- highest precision risk
- should be justified by data, not assumed

## Go / No-Go Criteria

### Go

- weighted RRF beats or matches current hybrid on the broad slice
- scene expansion improves evidence recall without unacceptable latency
- bridge discovery improves multi-evidence slices
- scorer parity shows whether the public gap is partly metric-driven

### No-Go

- any phase that regresses the broad slice without a compensating win on the targeted slice
- graph traversal that adds noise faster than it adds useful evidence
- any attempt to “win the benchmark” by changing the scorer and retrieval stack at the same time

## Recommended Immediate Next Step

Start with one bounded implementation cycle:

1. add normalized accuracy beside F1 / EM
2. add the deterministic query strategy classifier
3. wire weighted RRF with strategy-specific weights
4. rerun the same LoCoMo slices

That is the shortest path to learning whether the gap is mostly scoring methodology, retrieval routing, or both.
