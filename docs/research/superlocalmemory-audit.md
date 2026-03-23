# SuperLocalMemory Audit for Cortex

Date: 2026-03-22  
Author: Codex research pass  
Target: `qualixar/superlocalmemory` at commit `cbf59cd465adefac0670f724b080009ecfb7bb6a` (commit date: 2026-03-23 03:01:12 +0530)  
Comparison target: local `hurttlocker/cortex` source at commit `4da4d215308220a1493e20cd2c72977bad3b24fc` and local binary `cortex 1.3.0`

## Executive Summary

SuperLocalMemory (SLM) is real and technically interesting, but its practical moat is narrower than the branding suggests.

The biggest product advantages are:

- a 4-channel retrieval stack instead of Cortex's current 2-channel default
- canonical entity resolution plus entity-profile lookup
- a local cross-encoder reranker in the hot path
- better conversational ingestion for people, dates, aliases, and temporal facts

The biggest marketing advantages are:

- Fisher-Rao information geometry
- sheaf cohomology contradiction checking
- Langevin lifecycle math

Those math layers are not where Cortex should start.

If the goal is to beat SLM as a local-first agent memory system, the priority order should be:

1. local reranking
2. canonical entity graph + profile retrieval
3. stronger fact extraction for conversations
4. temporal retrieval as a first-class channel
5. scene/bridge retrieval for multi-hop
6. better answer synthesis

Only after those should we consider Fisher-Rao-style uncertainty-aware ranking.

## What I Reviewed

### SuperLocalMemory

- GitHub repo: `https://github.com/qualixar/superlocalmemory`
- Paper: `https://arxiv.org/abs/2603.14588` submitted on March 15, 2026
- Key docs:
  - `README.md`
  - `wiki-content/V3-Architecture.md`
  - `wiki-content/V3-Mathematical-Foundations.md`
  - `wiki-content/Modes-Explained.md`
- Key code:
  - `src/superlocalmemory/retrieval/*`
  - `src/superlocalmemory/math/fisher.py`
  - `src/superlocalmemory/encoding/graph_builder.py`
  - `src/superlocalmemory/core/engine.py`
  - `src/superlocalmemory/core/config.py`

### Cortex

- Repo: `../cortex`
- Current merged benchmark notes:
  - `docs/research/cortex-combined-benchmark-2026-03-22.md`
  - `../cortex/docs/archive/locomo-conv30-quickwins-baseline-2026-03-22.md`
  - `../cortex/docs/archive/locomo-conv30-temporal-phaseab-2026-03-22.md`
  - `../cortex-multihop/docs/archive/locomo-multihop-mvp-eval-2026-03-22.md`
- Key code:
  - `../cortex/internal/search/search.go`
  - `../cortex/internal/search/rrf.go`
  - `../cortex/internal/temporal/temporal.go`
  - `../cortex/internal/store/inference.go`
  - `../cortex/internal/ask/engine.go`
  - `../cortex/docs/ARCHITECTURE.md`
  - `../cortex/docs/DECISIONS.md`

## Important Benchmark Caveat

Do not treat SLM's `74.8%` and `87.7%` as a clean like-for-like delta.

- SLM Mode A is documented as `74.8%` over `10 conversations` and `1,276 questions`.
- SLM Mode C is documented as `87.7%` on `conv-30` only, `81 questions`.

That means the public repo is not showing a single matched benchmark split where only "cloud synthesis" changed.

This matters because "Mode C adds 12.9 points" is not actually established by the public artifacts.

There is also public metric ambiguity:

- the docs describe these as LoCoMo "scores" or "aggregate" results
- but the repo does not publish a full scorer harness clarifying whether every number is retrieval accuracy, answer accuracy, or a mixed benchmark protocol

I also did not find a public full LoCoMo evaluation harness in the repo at `cbf59cd`. I found docs, wiki tables, and `tests/test_final_locomo_mini.py`, which is a small synthetic integration test, not the published full benchmark pipeline.

## 1. SLM Architecture: What It Actually Is

SLM V3's retrieval path is:

`query -> strategy classifier -> 4 parallel channels -> weighted RRF -> scene expansion -> bridge discovery -> cross-encoder rerank -> top-k`

The four channels are:

- semantic: embedding similarity with Fisher-Rao weighting
- BM25: keyword retrieval
- entity graph: spreading activation from resolved entities
- temporal: normalized date-aware retrieval

The ingestion path is not generic note import. It is a structured conversation-memory pipeline:

1. entropy gate
2. fact extraction
3. entity resolution
4. temporal parsing
5. type routing
6. emotional signal extraction
7. graph construction
8. consolidation
9. scene clustering
10. observation building
11. foresight generation

This is the real story. SLM is not "just better vector search." It is a typed memory system with several retrieval indexes built at write time.

## 2. How Fisher-Rao Retrieval Works

### In SLM

SLM models an embedding as a diagonal Gaussian:

- mean = normalized embedding vector
- variance = per-dimension confidence

Distance is then computed on the statistical manifold instead of plain vector space. In the full implementation:

- each memory has `fisher_mean` and `fisher_variance`
- repeated access narrows variance through a Bayesian precision-additive update
- semantic ranking can shift even when cosine direction is similar, because high-confidence memories carry tighter variance

In plain English:

- cosine asks: "are these vectors pointed in the same direction?"
- Fisher-Rao asks: "are these two embedding distributions similar, including uncertainty?"

### What It Gives Them That Cosine Does Not

The intended gain is confidence-sensitive retrieval:

- identical means but different uncertainty are distinguishable
- repeatedly confirmed memories can outrank weakly supported ones
- similarity can incorporate "how stable this memory is," not only "how semantically close it is"

That is the theoretical advantage.

### The Important Practical Caveat

The public code weakens the headline a bit:

- `SemanticChannel` uses a graduated ramp from cosine to Fisher based on `access_count`
- default `fisher_mode` is `"simplified"`, not the full geodesic
- `SemanticChannel` itself states that on fresh benchmark data with identical variances, Fisher reduces to a scaled Euclidean/cosine ranking

My inference from the code:

- Fisher-Rao is probably valuable in a long-lived interactive memory where recalls update uncertainty over time
- it is probably not the first-order reason SLM beats other systems on a static benchmark import
- the larger practical gains are more likely coming from multi-channel retrieval, reranking, and better ingestion

So: Fisher-Rao is interesting, but it is not the first thing Cortex should copy.

## 3. How the Entity Graph Works

### How It Is Built

SLM builds the entity graph at ingestion time, not as a post-hoc visualization.

The process is:

1. extract named entities from the fact
2. resolve them to canonical entity IDs with alias tracking
3. create graph edges for the new fact

Edge types created by `encoding/graph_builder.py`:

- `ENTITY`: facts sharing a canonical entity
- `TEMPORAL`: facts about the same entity within a time window, weighted by time decay
- `SEMANTIC`: ANN-nearest facts above a similarity threshold
- `CAUSAL`: cue-based causal edges from phrases like "because", "led to", "as a result"

SLM also stores:

- canonical entities
- aliases
- entity profiles
- temporal events
- memory scenes

### How It Is Queried

The entity channel does this:

1. extract entity candidates from the query
2. resolve them to canonical IDs
3. seed activation from facts linked to those IDs
4. traverse graph neighbors up to 3 hops with decay `0.7`
5. discover additional entities from activated facts
6. return facts with activation score

There is also a profile shortcut:

- if the query names a known entity, SLM can directly inject that entity's profile facts into the candidate pool with a high score

For multi-hop, SLM adds:

- bridge discovery over top fused results
- spreading activation over graph edges
- scene expansion to pull related facts from matched scenes

### What This Buys Them

This solves a real retrieval problem that Cortex still has:

- embeddings are good at semantic neighborhood
- BM25 is good at exact lexical overlap
- neither is good at "find all facts connected to Alice, then walk to Bob, then infer the bridge"

SLM's entity graph is a real retrieval index, not just a UI graph.

## 4. How They Get 74.8% With Zero Cloud

Mode A is not zero-LLM by being simple. It is zero-LLM by replacing cloud dependence with more local structure.

Mode A's main ingredients are:

- local embeddings, defaulting to `nomic-embed-text-v1.5`
- BM25 keyword retrieval
- canonical entity resolution and entity graph traversal
- temporal indexing and date-aware matching
- weighted RRF fusion
- local cross-encoder reranking with `BAAI/bge-reranker-v2-m3`
- local mathematical weighting and lifecycle updates

The most important observation from SLM's own ablation table:

- removing cross-encoder reranking hurts more than removing anything else
- removing BM25 also hurts a lot
- entity graph and temporal help, but smaller individually

So the practical Mode A recipe is:

`better indexes + local reranking + strong ingestion`

not:

`math alone`

## 5. How They Get 87.7% With Partial Cloud

Mode C adds several things at once:

- cloud embeddings by default (`text-embedding-3-large`, 3072d)
- LLM fact extraction at ingest
- LLM entity/type disambiguation
- agentic two-round retrieval when initial results are weak
- cloud answer synthesis

What "partial cloud" means in practice:

- storage remains local SQLite
- but query text, imported text, and synthesized answer context can leave the machine

This is visible in code:

- Mode C config defaults to cloud embeddings and cloud LLM
- summarization/synthesis sends retrieved memory text to OpenRouter
- agentic retrieval uses LLM sufficiency and query rewrite
- despite the capability docs mentioning a cloud reranker option, the current engine still instantiates the local `BAAI/bge-reranker-v2-m3` cross-encoder

So the right mental model is:

- local database
- cloud-assisted ingest and answer path

not:

- "mostly local except for a small synthesis step"

## 6. Mode A vs Mode C: What the Synthesis Actually Adds

The public docs talk about "synthesis," but the Mode A to Mode C delta is not only synthesis.

Mode C changes four things at once:

1. ingestion quality improves because facts are extracted by LLM
2. semantic retrieval quality improves because embeddings are larger/cloud-based
3. retrieval can do a bounded second round with rewritten queries
4. final answers are composed by an LLM instead of returning excerpts

So if the question is "what does synthesis itself add?" the honest answer is:

- it mainly converts retrieved snippets into benchmark-shaped direct answers
- it likely helps exact phrasing and answer completeness
- but the public repo does not isolate synthesis from the other Mode C upgrades

My inference:

- Mode C's jump is partly retrieval quality
- partly better ingestion
- partly answer shaping
- and the public materials do not separate those effects cleanly

## 7. Cortex vs SLM: Technique Map

| Technique | SLM | Cortex today | Status |
| --- | --- | --- | --- |
| SQLite + FTS5 local store | yes | yes | parity |
| BM25 lexical retrieval | yes | yes | parity |
| Semantic embeddings + ANN | yes | yes via HNSW | parity |
| Default fusion strategy | weighted RRF | weighted score fusion, optional RRF | different, both credible |
| Local cross-encoder reranker | yes, in hot path | no cross-encoder reranker in search | missing |
| Canonical entity store + alias table | yes | no canonical entity layer | missing |
| Entity profile shortcut channel | yes | no equivalent | missing |
| Entity graph retrieval channel | yes | no true entity channel; only inferred graph/co-occurrence | missing |
| Temporal retrieval as a first-class channel | yes | partial; temporal parsing and temporal boost exist | partial |
| Scene clustering for retrieval expansion | yes | graph clusters exist mainly for visualization | partial |
| Bridge discovery for multi-hop | yes | deterministic planner branch regressed and is parked | partial / not production-ready |
| Query-type adaptive channel weights | yes | some query shaping and priors, but not 4-channel adaptive routing | partial |
| Better conversation-native fact extraction | yes | rule-based extraction plus optional LLM enrichment/classify | partial |
| Emotional signal extraction | yes | no equivalent | missing |
| Entity resolution with LLM fallback | yes | no true entity resolution layer | missing |
| Temporal event table | yes | temporal norms attached to facts, not a dedicated temporal retrieval table | partial |
| Local answer synthesis mode | yes in Mode B | Cortex can use local-compatible providers, but no explicit local-only memory mode | partial |
| Agentic retrieval | yes in Mode C | experimental planner exists, but benchmark-regressed | partial |
| Fisher-Rao uncertainty-aware similarity | yes | no | missing |
| Sheaf contradiction detection | yes | simple conflict detection by same subject/predicate different object | partial |
| Langevin lifecycle | yes | Ebbinghaus decay lifecycle | partial |
| Trust/provenance scoring | yes | provenance and lifecycle exist; no equivalent Bayesian trust model | partial |
| End-to-end benchmark documentation | docs and papers, but no full public harness found | yes, with benchmark notes in repo | Cortex stronger on honest reproducibility |

## 8. The Most Important Gap Assessment

### What Cortex Already Has

Cortex is not starting from zero. It already has:

- SQLite + FTS5 + embeddings + HNSW
- BM25, semantic, hybrid fusion, optional RRF
- confidence decay and reinforcement
- temporal normalization and temporal score boosting
- graph edges, co-occurrence, cluster visualizer
- optional LLM enrichment/classification
- answer synthesis paths (`answer`, `ask`)
- benchmark discipline and documented LoCoMo notes

### What Cortex Is Missing That Matters Most

The biggest missing pieces are not abstract math. They are retrieval plumbing:

1. local reranking after fusion
2. canonical entity resolution with aliases
3. an actual entity retrieval channel
4. better conversation-native extraction with absolute dates and coref repair
5. a stronger multi-hop retrieval/answer composition path

## 9. What We Should Steal vs What We Should Ignore

### Steal Now

- local cross-encoder reranking
- canonical entities + aliases + entity profiles
- entity graph retrieval with spreading activation
- temporal retrieval as a channel, not only a boost
- scene expansion and bridge discovery
- stronger conversational extraction with date normalization

### Steal Later

- uncertainty-aware similarity if we want long-lived confidence-sensitive ranking
- bounded agentic retrieval after base retrieval is strong

### Ignore for Now

- sheaf cohomology
- Langevin lifecycle replacement
- "paper-first" math branding

Reason:

SLM's own ablations say cross-encoder and multi-channel retrieval matter more than the fancy math, and Cortex is still missing those basics.

## 10. Concrete Close-the-Gap Roadmap

Baseline for these estimates:

- current honest Cortex `ask` score on `conv-30` is `11.42%` F1 from `docs/research/cortex-combined-benchmark-2026-03-22.md`
- current retrieval-only `conv-30` top-5 hit is `67.90%` BM25 and `60.49%` hybrid on merged `main`

These gain estimates are directional engineering estimates, not guaranteed outcomes.

| Priority | Technique | Why it matters | Effort | Expected LoCoMo gain |
| --- | --- | --- | --- | --- |
| 1 | Add a local cross-encoder reranker after hybrid fusion | This is the largest practical missing piece. SLM's own ablation says reranking is the single biggest contributor. | 1-2 weeks | `+4 to +10` F1 on `conv-30`; likely `+5 to +12pp` retrieval precision |
| 2 | Build canonical entity resolution with alias storage | Needed before any real entity graph works. Also improves extraction, graph quality, and exact entity lookup. | 2-3 weeks | `+2 to +5` F1 overall; larger gain on single-hop/entity questions |
| 3 | Add entity profiles plus a direct entity lookup channel | Gives SLM-style "What does Alice do?" shortcuts without full semantic search. | 1-2 weeks | `+1 to +3` F1 overall; `+4 to +8pp` on entity-centric retrieval |
| 4 | Add an entity graph retrieval channel with spreading activation | This closes the biggest retrieval-shape gap between Cortex and SLM. | 2-3 weeks | `+2 to +6` F1 overall; strongest on multi-hop/commonality queries |
| 5 | Upgrade extraction for conversational corpora | Extract fewer but better atomic facts, normalize dates, resolve pronouns, and preserve speaker/session anchors. | 2-4 weeks | `+3 to +8` F1 overall; compound gain across all categories |
| 6 | Promote temporal search from boost to first-class retrieval channel | Cortex has temporal norms already. It needs temporal candidate generation, not just post-score boosting. | 1-2 weeks | `+1 to +3` F1 overall; `+5 to +15pp` on temporal category |
| 7 | Add scene grouping and bridge discovery | Good retrieval pool expansion for related evidence without full agentic complexity. | 1-2 weeks | `+1 to +3` F1 overall |
| 8 | Rebuild answer synthesis around slot-filling and citation repair | Current `ask` beats `answer`, but both still fail exact-answer discipline. | 1-2 weeks | `+2 to +6` F1 overall |
| 9 | Revisit agentic retrieval with one planner call, not per-hop loops | The deterministic planner branch regressed. Do not ship that version. Use a bounded planner only after retrieval stack is stronger. | 2-3 weeks | `0 to +4` F1; high variance, high risk |
| 10 | Experiment with Fisher-style uncertainty-aware ranking | Useful only after repeated-access memory and retrieval behavior are stable. | 2-4 weeks | `0 to +2` F1 on static LoCoMo; potentially higher on live long-term memory |

## 11. Recommended Build Order

### Phase 1: Beat SLM on the practical stack

Build these first:

1. local cross-encoder reranker
2. canonical entities + aliases
3. entity profiles
4. entity graph channel
5. better conversation extraction

This is the shortest path to closing the real retrieval gap.

### Phase 2: Close temporal and multi-hop

Then add:

1. first-class temporal retrieval channel
2. scene expansion
3. bridge discovery
4. answer-path cleanup

This is the shortest path to better LoCoMo temporal and multi-hop behavior.

### Phase 3: Only then add research math

After the above, evaluate:

1. uncertainty-aware ranking
2. stronger contradiction logic
3. more principled lifecycle math

This is where Fisher-Rao may become worth it.

## 12. Bottom Line

SuperLocalMemory is ahead of Cortex in one area that matters a lot:

- retrieval architecture built around canonical entities, temporal facts, multi-index recall, and local reranking

It is not obviously ahead because of Fisher-Rao, sheaf cohomology, or Langevin dynamics.

If we want Cortex to become the best local-first agent memory system, the build order should be:

1. make retrieval structurally better
2. make ingestion structurally better
3. make answer composition stricter
4. only then chase mathematical novelty

That is the highest-confidence path to closing the actual gap.

## References

- SuperLocalMemory repo: `https://github.com/qualixar/superlocalmemory`
- SuperLocalMemory V3 paper: `https://arxiv.org/abs/2603.14588`
- SLM architecture wiki: `https://github.com/qualixar/superlocalmemory/wiki/V3-Architecture`
- SLM mathematical foundations wiki: `https://github.com/qualixar/superlocalmemory/wiki/V3-Mathematical-Foundations`
- Cortex repo: `https://github.com/hurttlocker/cortex`
