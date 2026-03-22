# Cortex vs LoCoMo Benchmark

## Status

Supermemory comparison is still pending for this issue. I did not include them in the scored table below because this run was focused on a reproducible Cortex baseline.

## Executive Summary

- Cortex can ingest the released LoCoMo corpus quickly and search it reliably.
- BM25 is fast and respectable for open-domain questions, but weak on multi-hop and temporal grounding.
- Hybrid retrieval improves evidence recall, but only slightly improves direct answer coverage while adding a large latency penalty.
- The current Cortex + single-shot reader stack is far below the published LoCoMo numbers from dedicated memory systems.
- The main bottleneck is retrieval/composition, not just reader-model quality.

## Dataset Notes

The issue text said LoCoMo had "81 Q&A pairs". That does not match the public release.

- Public LoCoMo release: 10 conversations, 1,986 QA pairs total.
- Answerable slice used by many public vendor comparisons: categories 1-4 only, 1,540 questions.
- One public conversation, `conv-30`, happens to contain 81 answerable questions. That is the most likely source of the "81" figure in the issue.

The issue also pointed at `arXiv:2402.09714`. The public LoCoMo paper/repo point to ACL 2024 / `arXiv:2402.17753`.

## Methodology

### Corpus setup

- Source dataset: `locomo10.json` from the public LoCoMo repo.
- I converted the 10 conversations into 10 markdown files, preserving session headers and original dialog IDs like `D1:3`.
- Cortex import split those files into 764 memories and extracted 4,456 rule-based facts.

### Cortex setup

- Binary: `~/bin/cortex` (`1.3.0`)
- Benchmark DB: `/tmp/cortex-locomo-run-fast/cortex.db`
- I used an isolated DB instead of `~/.cortex/cortex.db` to avoid contaminating the user’s live memory store and to keep the benchmark reproducible.

### Import command

I first tried the default `cortex import ... --extract` path. That run became dominated by import-time OpenRouter enrichment/classification rather than search quality, so I reran the benchmark with retrieval-focused settings:

```bash
cortex --db /tmp/cortex-locomo-run-fast/cortex.db \
  import /tmp/cortex-locomo-run-fast/corpus \
  --recursive \
  --extract \
  --no-enrich \
  --no-classify
```

That keeps Cortex extraction enabled while removing optional import-time LLM augmentation.

### Retrieval setup

- Search limit: top 5 results
- BM25 mode: `cortex search "<question>" --mode bm25 --limit 5 --json`
- Hybrid mode: `CORTEX_EMBED=openrouter/text-embedding-3-small cortex search "<question>" --mode hybrid --limit 5 --json`

I had to sanitize punctuation in the raw benchmark questions before passing them to `cortex search`, because Cortex/FTS would otherwise throw syntax errors on some literal quoted questions.

I also had to use OpenRouter embeddings for the hybrid run. In this environment, local Ollama query embeddings were not stable enough to finish the sweep, so the hybrid numbers below are not a fully local benchmark.

### Reader setup

For the LLM-assisted mode, I did not use `cortex answer`, because the current CLI path falls back away from hybrid search. Instead, I followed the issue literally:

1. Run `cortex search --mode hybrid`
2. Feed the top 5 retrieved excerpts plus the question into a reader model
3. Score the output

Reader model:

- `openrouter/google/gemini-2.0-flash-001`

Scoring:

- Retrieval-only modes: top-1 evidence hit, top-5 evidence hit, evidence recall, answer-string hit
- LLM-assisted mode: LoCoMo-style category-specific F1 and exact match

Important caveat: the vendor-published numbers below are mostly LLM-as-a-judge accuracy claims, not the stricter F1 metric used here for Cortex.

## Results

### Main Table

| Mode | Metric | Full answerable slice (1,540 q) | `conv-30` slice (81 q) |
| --- | --- | ---: | ---: |
| BM25 | Top-5 evidence hit | 68.90% | 69.14% |
| BM25 | Evidence recall | 62.46% | 64.36% |
| BM25 | Answer-string hit | 23.18% | 34.57% |
| BM25 | Avg latency | 126 ms | 131 ms |
| Hybrid | Top-5 evidence hit | 77.66% | 61.73% |
| Hybrid | Evidence recall | 71.26% | 57.96% |
| Hybrid | Answer-string hit | 24.22% | 28.40% |
| Hybrid | Avg latency | 4,083 ms | 3,732 ms |
| Hybrid + LLM | F1 | 33.78% | 27.89% |
| Hybrid + LLM | Exact match | 8.12% | 7.41% |
| Hybrid + LLM | Avg reader latency | 669 ms | 648 ms |

### Category Breakdown

#### BM25 retrieval

| Category | Meaning | Top-5 hit | Evidence recall | Answer hit |
| --- | --- | ---: | ---: | ---: |
| 1 | Single-hop | 67.02% | 36.79% | 10.28% |
| 2 | Temporal | 66.98% | 64.75% | 14.64% |
| 3 | Multi-hop | 41.67% | 38.06% | 8.33% |
| 4 | Open-domain | 73.37% | 72.99% | 32.46% |

#### Hybrid retrieval

| Category | Meaning | Top-5 hit | Evidence recall | Answer hit |
| --- | --- | ---: | ---: | ---: |
| 1 | Single-hop | 77.30% | 47.86% | 12.77% |
| 2 | Temporal | 75.08% | 72.79% | 14.95% |
| 3 | Multi-hop | 54.17% | 46.70% | 10.42% |
| 4 | Open-domain | 81.45% | 81.33% | 33.17% |

#### Hybrid + LLM

| Category | Meaning | F1 | Exact match |
| --- | --- | ---: | ---: |
| 1 | Single-hop | 24.88% | 3.90% |
| 2 | Temporal | 23.09% | 2.80% |
| 3 | Multi-hop | 8.01% | 0.00% |
| 4 | Open-domain | 43.79% | 12.49% |

## Comparison to Published Scores

These are public claims from the vendors themselves. They are not apples-to-apples with the Cortex F1 score above, but they are still useful as a market reference.

| System | Published LoCoMo score | Source |
| --- | ---: | --- |
| EverMemOS | 93.05% overall accuracy | EverMind about page |
| Zep | 80.32% accuracy in a single retrieval call | Zep "Mem0 alternative" page |
| Letta | 74.0% accuracy | Letta blog post |
| Mem0 | 66.9% accuracy | Mem0 research page |
| Mem0ᵍ | 68.4% accuracy | Mem0 research page |

Interpretation:

- Cortex hybrid retrieval is directionally decent, but Cortex’s end-to-end answer quality in this setup is nowhere near the published LoCoMo leaders.
- Even a stronger reader model did not close the gap enough.

On a quick sanity check, I reran only the `conv-30` 81-question slice with a stronger reader model, `openrouter/x-ai/grok-4.1-fast`. That improved the slice from `27.89%` F1 / `7.41%` EM to `36.9%` F1 / `16.05%` EM. That is a real gain, but still far below the public vendor scores, which suggests the main issue is not just the reader.

## Where Cortex Wins

- Deployment shape: single binary, SQLite store, and a fast fully local BM25 mode.
- Import speed: the released corpus imported in about 9.8 seconds once optional enrichment/classification was removed.
- Simplicity: the benchmark required only markdown import plus stock `cortex search`.
- BM25 latency: around 126 ms average per query is good for a local baseline.

## Where Cortex Loses

- Temporal reasoning: retrieved sections often contain relative dates like "last week" while the benchmark expects normalized or anchored dates.
- Multi-hop composition: category 3 collapses hardest. Hybrid only reaches 54.17% top-5 evidence hit, and the reader only reaches 8.01% F1.
- Exact-answer retrieval: hybrid improves evidence recall a lot more than it improves answer-string coverage.
- Hybrid latency: retrieval improves, but average latency jumps from ~126 ms to ~4.1 s per query in this environment.

## What Seems To Be Going Wrong

From the failure samples, the current system struggles in four recurring ways:

1. It retrieves the right neighborhood but not the exact evidentiary turn.
2. It retrieves only one side of a multi-hop question.
3. It surfaces relative temporal language without normalizing it to the benchmark target.
4. The reader often outputs a plausible paraphrase or relative phrase instead of the exact benchmark answer form.

Examples:

- Expected `7 May 2023`, predicted `Not mentioned`
- Expected `The week before 9 June 2023`, predicted `Last week`
- Expected `Transgender woman`, predicted `Expressing my trans experience.`
- Expected `Psychology, counseling certification`, predicted `Counseling or mental health work.`

## Specific Retrieval Improvements To Close The Gap

1. Add a benchmark-oriented ingest mode for conversational corpora.
   Cortex currently chunks generic markdown reasonably well, but LoCoMo wants turn-precise, session-aware retrieval. A native transcript/session import path would help.

2. Add date normalization and temporal anchoring.
   Cortex should carry both the literal phrasing and a normalized date representation into indexable facts/snippets.

3. Tune hybrid ranking for exact-detail QA, not just semantic relatedness.
   The current hybrid path clearly improves recall, but it barely improves answer-string hit rate. That suggests the semantic side is over-helping broad relevance and under-helping exact answer selection.

4. Add multi-hop search planning.
   One-shot retrieval is not enough for LoCoMo-style category 3 questions. Cortex needs iterative query reformulation, hop chaining, or evidence-set reranking.

5. Make `cortex answer` truly hybrid-aware.
   In this environment, `cortex answer --mode hybrid` degraded instead of cleanly using the embedding-backed hybrid path. That forced a custom harness for the LLM-assisted mode.

6. Escape or sanitize FTS queries in the CLI.
   Literal benchmark questions with quotes caused syntax errors until I sanitized them externally.

## Repro Notes

- Raw benchmark output: `/tmp/cortex-locomo-run-fast/results.json`
- Temporary corpus: `/tmp/cortex-locomo-run-fast/corpus`
- Benchmark DB: `/tmp/cortex-locomo-run-fast/cortex.db`

## Sources

- LoCoMo paper: https://aclanthology.org/2024.acl-long.747/
- LoCoMo dataset/repo: https://github.com/snap-research/locomo
- EverMind / EverMemOS: https://evermind.ai/about
- Zep: https://www.getzep.com/mem0-alternative/
- Letta: https://www.letta.com/blog/benchmarking-ai-agent-memory
- Mem0 research: https://mem0.ai/research
