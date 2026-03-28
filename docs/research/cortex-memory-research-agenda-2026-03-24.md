# Cortex Memory Research Agenda — 2026-03-24

## Goal

Turn Cortex from a strong local-first retrieval system into a local-first memory system that:

- writes harder
- consolidates earlier
- separates memory by role and scope
- updates beliefs cleanly instead of mostly appending facts
- changes agent behavior, not just search results

This agenda is the synthesis of three directions:

- steal Mem0's aggressive write-time extraction and consolidation discipline
- steal Hindsight's explicit memory classes and reflection model
- keep Cortex's local-first single-binary shape, provenance, import-first workflow, and observability

## Recommendation

Start with the **import quality gate**.

Not reflection first.
Not another reranker first.
Not more retrieval channels first.

Reason:

1. bad writes poison everything downstream
2. the temporal student experiment already proved the tiny-gate pattern is viable
3. quality gates are cheap to ship inside the binary
4. better write-path quality compounds across retrieval, reflection, and behavior

## What To Keep vs Steal

### Keep From Cortex

- single-binary / local-first philosophy
- SQLite + provenance + export
- connectors / import-first posture
- visibility into what the system knows and why
- explicit lifecycle controls like reinforce / supersede / keep / drop

### Steal From Mem0

- more aggressive write-time extraction
- write-time consolidation
- profile / session / agent memory separation
- better update semantics instead of mostly append-only fact growth

### Steal From Hindsight

- explicit `world` / `experience` / `mental_model` split
- a real reflection pass
- stronger temporal reasoning
- memory that changes future actions and plans, not just recall output

## North Star Architecture

Cortex should evolve toward a memory model with two axes.

### Axis 1: memory class

- `world`
  stable facts about external reality, tools, systems, people, codebases
- `experience`
  episodic traces of what happened in a session or workflow
- `mental_model`
  distilled beliefs, heuristics, expectations, plans, and learned abstractions

### Axis 2: memory scope

- `profile`
  long-lived user / project / entity memory
- `session`
  local context for a specific run, tab, or conversation
- `agent`
  perspective-specific memory for one agent or observer

The important point is not just storing more facts.
It is storing the **right kind** of memory in the **right lane** with clean update semantics.

## Priority Order

## Phase 0: Baseline Discipline

Before adding more memory behaviors, keep the benchmark/eval discipline honest.

### Objectives

- keep the all-minilm baseline reproducible
- keep LoCoMo smoke and broader slices available
- add non-LoCoMo evals for write-path and update quality

### Required outputs

- stable all-minilm baseline reports
- question-level score artifacts
- import/write-path eval fixtures

### Success criteria

- every memory change can be measured against a known baseline
- no ambiguous “felt better” wins

## Phase 1: Import Quality Gate

This is the first build target.

### Problem

Cortex still imports too much low-value material.
If junk survives import, every later stage has to fight it:

- search ranking
- reflection
- belief updates
- profile generation

### Thesis

A tiny local keep/drop model should sit at import time and decide:

- is this memory worth storing at all?

This is the highest-leverage gate because it reduces noise before extraction, embedding, ranking, and reflection.

### Model shape

- TF-IDF features
- logistic regression
- exported as compact JSON
- runtime inference in Go as a small sparse dot-product scorer

No ONNX needed.
No heavy runtime needed.

### Training signal

Use the real cleanup work from the production DB:

- memories kept after cleanup
- memories dropped as garbage

Teacher-labeled review batches should correct the hard false positives and false negatives.

### Features to start with

- content length
- line count
- metadata ratio
- code / log / KV density
- source type
- keyword coverage
- repeated boilerplate markers
- timestamp / envelope / trace noise markers

### Why first

- highest downstream leverage
- cheap inference
- directly aligned with the temporal student success pattern

### Success criteria

- reduce imported memory count materially without hurting benchmark recall
- reduce low-value memory growth in real corpora
- improve retrieval precision on repo/doc queries

## Phase 2: Temporal Keep/Drop Gate

This is already proven enough to move from experiment toward product.

### Evidence

The sibling Cortex branch already shows:

- temporal tiny-student viability
- teacher-labeled improvement
- strong keep/drop performance from a very small dataset

Current artifact:

- `/Users/marquisehurtt/clawd/repos/cortex/docs/research/temporal-student-viability-2026-03-24.md`

### Why second, not first

It is already viable, but it is narrower than the general import quality gate.

### Product role

Use it to decide:

- should this candidate temporal event be kept?

Then later expand into:

- event type classification
- anchor confidence
- relative-date resolution confidence

### Success criteria

- fewer junk temporal events at write time
- better temporal retrieval precision
- improved temporal answer normalization downstream

## Phase 3: Fact Quality Gate

### Problem

Even when a memory deserves to exist, not every extracted fact deserves to survive.

### Thesis

Add a post-extraction fact gate:

- is this fact useful for retrieval or memory state?

This should reduce:

- transcript-shaped junk facts
- weak KV fragments
- low-value paraphrastic duplicates

### Training signal

Use:

- facts that contribute to successful retrieval / answer paths
- facts never recalled or consistently dominated by better alternatives

### Success criteria

- lower fact volume with better retrieval precision
- cleaner entity / profile materializations
- fewer useless facts in explainability surfaces

## Phase 4: Memory Lanes and Scope Separation

Once write quality is under control, split memory lanes.

### Objective

Move from one mostly flat fact store toward scoped and typed memory:

- `world`
- `experience`
- `mental_model`

across:

- `profile`
- `session`
- `agent`

### Why this matters

This is the bridge between Mem0 and Hindsight:

- Mem0-style scoped memory lanes
- Hindsight-style explicit memory classes

### Suggested shape

- facts remain source of truth
- profiles and session summaries are derived views
- scoped memories can supersede or reinforce only within compatible lanes

### Success criteria

- better recall packing
- better agent-specific behavior
- less contamination between temporary session state and long-lived belief state

## Phase 5: Better Update Semantics

### Problem

Cortex still behaves too much like:

- append another fact
- hope ranking and lifecycle sort it out later

### Target behavior

Write-time decisions should choose among:

- append new fact
- reinforce existing fact
- supersede outdated fact
- merge into profile
- update session state
- reject as noise

### Why this matters

Without stronger update semantics:

- contradictions accumulate
- profiles get bloated
- reflection writes duplicate what retrieval already knows

### Success criteria

- lower duplicate growth
- cleaner profile and belief state
- easier operator trust in “current truth”

## Phase 6: Reflection Pass

This is the first place where Hindsight becomes real instead of aesthetic.

### Objective

Add a true reflect phase that writes distilled memory, not just searchable residue.

### Reflection outputs

- `experience -> mental_model`
  lessons, abstractions, strategy updates
- `experience -> world`
  stable observed facts
- `session -> profile`
  durable user or project changes

### Reflection should do

- compress repeated experience into a stable lesson
- revise or supersede outdated mental models
- extract behavior-relevant heuristics
- attach temporal anchors cleanly

### Reflection should not do

- become the primary source of truth
- hide provenance
- rewrite raw history

### Success criteria

- better future action selection
- fewer repeated mistakes across sessions
- cleaner long-lived memory surfaces

## Phase 7: Behavior-Change Evals

This phase makes the memory system accountable for outcomes, not just search quality.

### Needed evals

- does memory change the chosen plan?
- does memory reduce repeated operator corrections?
- does memory improve update correctness?
- does reflection alter future behavior in the right direction?

### Example eval classes

- plan-selection eval
- belief-update eval
- temporal consistency eval
- profile accuracy eval
- session-to-profile promotion eval

### Success criteria

- measurable behavior deltas from memory, not just retrieval deltas

## Tiny Gate Architecture

All gate models should follow one cheap pattern unless they prove insufficient.

### Train

- Python scripts
- TF-IDF + logistic regression
- small teacher-labeled datasets
- export pure JSON model artifacts

### Ship

- JSON artifact embedded in the repo / binary
- Go inference path
- sparse dot product + threshold
- sub-millisecond inference target

### Improve

- collect hard cases
- run teacher label pass
- retrain
- compare against previous gate on fixture and real-corpus metrics

This matches the temporal student experiment and is much cheaper than treating every gate as a heavy model-serving problem.

## Research Tracks

## Track A: Write-Time Intelligence

Build in this order:

1. import quality gate
2. temporal keep/drop gate
3. fact quality gate
4. update/supersede routing

This is the highest-confidence product path.

## Track B: Memory Structure

Build in this order:

1. `world` / `experience` / `mental_model`
2. `profile` / `session` / `agent` scope
3. derived scoped profiles
4. perspective-aware retrieval and packing

This is the right long-term architecture path.

## Track C: Reflection and Behavior

Build in this order:

1. reflection pass
2. mental-model updates
3. behavior-change evals
4. policy/plan influence hooks

This is what turns memory into an actual cognitive substrate.

## What To Build Next

Recommended immediate sequence:

1. finish the all-minilm benchmark runner enough that baseline updates are cheap
2. write the import quality gate plan
3. reuse the temporal student pattern for import gating
4. define the `world` / `experience` / `mental_model` schema before building reflection

### Exact next artifact

The next doc to write in this repo should be:

- `docs/research/cortex-import-quality-gate-plan.md`

That plan should cover:

- dataset construction
- teacher labeling loop
- JSON model export format
- Go runtime inference shape
- benchmark and real-corpus evals

## Bottom Line

The first big win is not “better search.”

It is:

- better writes
- better separation of memory lanes
- better update semantics
- better distilled state

The tiny-gate pattern is the shortest path to getting there.

Build the import quality gate first, treat the temporal gate as the proof case, and let every later memory improvement depend on cleaner write-time state.

## Companion Spec

- `docs/research/cortex-import-quality-gate-plan.md`
