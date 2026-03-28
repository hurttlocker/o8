# Cortex AutoResearch — Updated Main AllMiniLM Baseline — 2026-03-24

## Scope

This note records the first successful updated-`main` baseline on the shipping `all-minilm` embedder path after `#359` landed on Cortex `main`.

- Cortex repo `main` SHA: `ad0a465`
- Embedder: `ollama/all-minilm`
- Search mode: `rrf`
- Answer model: `openrouter/google/gemini-2.5-flash`
- Corpus: full 10-conversation LoCoMo markdown render
- Scored slice: `conv-30` smoke subset of `3` answerable questions

Important implementation note:

- The stock Cortex embed loop still hangs on some memories in this environment.
- This baseline used the research-runner timeout bypass that embeds each memory through Ollama with an `8s` timeout and writes zero-vectors on failure so the eval can complete.

## Import + Embed

- import duration: `41.77s`
- memories: `501`
- facts: `3682`
- sources: `10`
- embeddings: `501`
- embedding dimensions: `384`

## Baseline Result

- evidence hits: `2/3`
- non-degraded answers: `3/3`
- exact matches: `0/3`
- average token F1: `0.2000`

## Question Breakdown

### 1. When Jon has lost his job as a banker?

- expected: `19 January, 2023`
- evidence hit: `true`
- answer: `Jon lost his job as a banker yesterday, as of January 20, 2023 [1].`
- token F1: `0.2667`

Interpretation:

- retrieval found the right evidence
- answer form is still relative instead of normalized

### 2. When Gina has lost her job at Door Dash?

- expected: `January, 2023`
- evidence hit: `true`
- answer: `Gina lost her job at Door Dash in January 2023 [1].`
- token F1: `0.3333`

Interpretation:

- this is the cleanest temporal answer in the smoke slice
- still not an exact-match under the current normalizer

### 3. How do Jon and Gina both like to destress?

- expected: `by dancing`
- evidence hit: `false`
- top section: `Session 16 - 2:15 pm on 21 June, 2023`
- answer: `not enough evidence`
- token F1: `0.0000`

Interpretation:

- this is still the weak commonality/composition case
- the all-minilm baseline did not fix the shared-preference miss

## Takeaway

On updated Cortex `main` with the shipping `all-minilm` embedder:

- temporal retrieval is still directionally okay on the smoke slice
- temporal answer normalization is still weak
- commonality/composition is still the main miss

So the baseline did move to the correct ship-path embedder, but it did **not** change the high-level diagnosis:

1. temporal answer shaping still needs work
2. shared/commonality retrieval-composition still needs work
3. the reranker branch is not worth spending more cycles on until the new daemon path exists
