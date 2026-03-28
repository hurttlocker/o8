# Cortex Import Quality Gate Plan

## Goal

Ship a tiny local keep/drop gate at import time that decides:

- should this memory be stored at all?

This is the first memory-quality gate Cortex should build.

## Why This Is First

The import quality gate has the highest leverage because it improves every downstream stage:

- extraction
- embedding
- retrieval
- reflection
- profile generation
- belief update quality

The temporal student experiment on the sibling Cortex repo already proved the core pattern:

- TF-IDF
- logistic regression
- tiny labeled dataset
- JSON export
- cheap runtime inference in Go

Current proof artifact:

- `/Users/marquisehurtt/clawd/repos/cortex/docs/research/temporal-student-viability-2026-03-24.md`

## Problem

Cortex still stores too many low-value memories:

- logs
- protocol noise
- boilerplate envelopes
- repetitive session residue
- low-signal transcript fragments
- machine-generated junk that is not worth embedding or extracting

Current defenses exist, but they are not enough:

- denylist patterns
- content-hash dedup
- cross-source dedup
- near-duplicate suppression
- low-signal capture toggles

Those are useful, but they are still mostly heuristic and brittle.

## Thesis

Add a tiny classifier in the import path that scores each `RawMemory` chunk before storage:

- `keep`
- `drop`

Later, extend it to:

- `keep`
- `drop`
- `demote`

But v1 should stay binary.

## Product Shape

### V1 behavior

For each parsed memory chunk:

1. run deterministic denylist first
2. run dedup/near-dup checks
3. run import quality gate
4. if below threshold:
   - do not store the memory
   - increment denied-at-import stats
   - record a machine-readable reason
5. if above threshold:
   - continue through normal store/extract/embed flow

### V1 design rule

The quality gate should be **advisory only to import**.

It should not:

- delete existing memories
- mutate stored memories retroactively
- supersede facts directly

Those can come later.

## Integration Seams In Cortex

Primary integration point:

- `/Users/marquisehurtt/clawd/repos/cortex/internal/ingest/ingest.go`
  `processMemory(...)`

Relevant current behavior:

- denylist match happens first
- dedup / cross-source dedup happens next
- low-signal capture and near-dup checks already exist
- accepted memories become `store.Memory`

Relevant CLI entry point:

- `/Users/marquisehurtt/clawd/repos/cortex/cmd/cortex/main.go`
  `runImport(...)`

This is good news because the gate can fit the current architecture cleanly without a large refactor.

## V1 Gate Architecture

### Runtime model

Use the same export pattern as the temporal keep/drop gate:

- lowercase text
- unigram + bigram TF-IDF
- logistic regression
- JSON artifact embedded in the binary

Do **not** use ONNX for this gate.

Reason:

- model is tiny
- inference is a sparse dot product
- Go runtime is easy to implement and inspect
- no extra runtime dependency is needed

### Export format

Match the temporal gate shape as closely as possible:

```json
{
  "kind": "import_quality_keepdrop_v1",
  "lowercase": true,
  "ngram_range": [1, 2],
  "token_pattern": "(?u)\\b\\w\\w+\\b",
  "features": ["error", "session", "heartbeat", "..."],
  "idf": [1.2, 0.9, 1.7],
  "coef": [0.4, -0.8, -1.2],
  "intercept": -0.35,
  "threshold": 0.58
}
```

Target Go seam:

- `internal/ingest/import_keepdrop_gate.go`
- embedded artifact:
  `internal/ingest/import_keepdrop_model.json`

## Dataset Plan

### Positive class

Memories that should be kept because they are useful to retrieval or durable memory state.

Examples:

- design docs
- decisions
- meaningful user/project notes
- high-signal conversation chunks
- chunks that later yield good facts or good retrieval evidence

### Negative class

Memories that should be dropped at write time.

Examples:

- protocol/status noise
- pure envelope or orchestration residue
- repetitive terminal heartbeat output
- boilerplate acknowledgements
- extremely low-information fragments
- machine-generated clutter that never becomes useful retrieval evidence

### Initial data sources

Build the dataset from three buckets:

1. real cleanup decisions from the production DB
2. import artifacts already denied or suppressed by existing heuristics
3. benchmark/import corpora with known high-signal chunks

### Dataset construction rule

Do not rely on proxy labels alone for long.

Proxy labels are acceptable to bootstrap the first review pack, but the training set should quickly become teacher-labeled.

## Teacher Labeling Loop

Use the same pattern that worked for the temporal student.

### Step 1: bootstrap

- create a mixed dataset from real memories
- assign initial proxy labels

### Step 2: review pack

Export the hardest rows:

- near threshold
- false positives
- false negatives
- disagreement with existing heuristics

### Step 3: teacher pass

Review `50-100` rows first, then expand.

Label:

- `teacher_label_keep`
- optional `teacher_reason`
- optional `teacher_bucket`

### Step 4: retrain

Retrain with teacher overrides replacing proxy labels.

### Step 5: repeat

Track whether additional labels still move F1 / precision / recall enough to justify more annotation.

## Features

Start with text-only features plus a small metadata bundle.

### Text features

- unigram TF-IDF
- bigram TF-IDF
- repeated boilerplate markers
- stack-trace / protocol / log noise markers
- status/heartbeat language
- extremely generic assistant filler language

### Metadata-derived features

These do not need to live inside the exported TF-IDF model if that complicates runtime.
They can be combined as cheap side features in Go.

Suggested v1 side features:

- content length
- line count
- digit ratio
- punctuation ratio
- source extension
- source path class
- section name class
- code block ratio
- unique token ratio

### Explicitly avoid in v1

- embeddings
- LLM classification
- expensive structural parsers

This gate must stay cheap.

## Scripts To Build

Follow the temporal student pattern.

### Training script

New script:

- `scripts/bench/import_quality_student.py`

Responsibilities:

- load dataset JSONL
- train TF-IDF + logistic regression
- cross-validate
- export report
- export review pack
- optionally export JSON runtime model

### Teacher helper

New script:

- `scripts/bench/import_quality_teacher.py`

Responsibilities:

- load review pack
- merge teacher labels
- emit overrides JSONL

### Dataset builder

New script:

- `scripts/bench/build_import_quality_dataset.py`

Responsibilities:

- sample real memories from a DB or corpus
- attach proxy labels and metadata
- create the first training dataset

## Runtime Implementation

### New Go type

Create:

- `ImportKeepDropGate`

Methods:

- `Score(text string, meta GateMeta) float64`
- `Keep(text string, meta GateMeta) bool`

### Gate metadata

Suggested runtime struct:

```go
type GateMeta struct {
  SourceFile    string
  SourceSection string
  ContentLen    int
  LineCount     int
}
```

### Import flow hook

Insert the gate inside `processMemory(...)` after:

- denylist
- exact dedup
- cross-source dedup

and before:

- `AddMemory(...)`

### Import accounting

When the gate drops a memory:

- increment denied-at-import counter
- record a specific reason such as `import_quality_gate`
- expose counts in dry-run output and JSON reports

## Evaluation Plan

## Offline metrics

For the gate model itself:

- F1
- precision
- recall
- confusion matrix
- hardest false positives
- hardest false negatives

### Threshold preference

Bias toward precision first.

Why:

- false positives pollute the entire memory system
- false negatives are painful, but easier to recover from with later teacher labeling

That said, do not let recall collapse. The gate should not become “only keep docs.”

## System metrics

Run before/after comparisons on real import workloads:

- memories stored
- facts extracted
- embeddings written
- storage size
- retrieval precision on fixture queries
- LoCoMo smoke slice deltas

### Real-world eval sets

Need at least three corpora:

1. noisy production memory dump
2. clean doc-heavy corpus
3. conversational/transcript-heavy corpus

The gate is only viable if it helps the noisy corpus without damaging the clean one.

## Benchmark guardrails

Gate must not materially hurt:

- top-5 evidence hit on smoke queries
- answer token F1 on the current all-minilm baseline

If import count drops a lot but retrieval quality also drops, the gate is not ready.

## Rollout Plan

### Phase 1

- offline only
- train/eval/review loop
- no product integration

### Phase 2

- `--import-quality-gate` experimental flag
- dry-run reporting
- operator can see dropped examples

### Phase 3

- enabled for selected corpora / benchmarks
- compare against ungated imports

### Phase 4

- default-on for import, with override escape hatch

## Success Criteria

Ship v1 only if all of these are true:

1. gate model is stable under teacher-labeled review
2. import volume drops materially on noisy corpora
3. retrieval precision improves or stays neutral
4. all-minilm benchmark smoke slice does not regress materially
5. operators can inspect why a memory was dropped

## Non-Goals

Not in v1:

- full memory-lane routing
- profile/session/agent splitting
- reflection
- fact supersede routing
- behavior-change policy hooks

Those depend on cleaner writes first.

## Recommended Immediate Work

Build in this order:

1. `scripts/bench/build_import_quality_dataset.py`
2. `scripts/bench/import_quality_student.py`
3. `scripts/bench/import_quality_teacher.py`
4. `internal/ingest/import_keepdrop_gate.go`
5. `internal/ingest/import_keepdrop_model.json`
6. import-path flag + dry-run reporting

## Bottom Line

The import quality gate is the best next move because it attacks the root of memory quality:

- bad writes

It matches the proven temporal student pattern, fits the current Cortex architecture, ships cheaply inside the binary, and improves every later memory capability.
