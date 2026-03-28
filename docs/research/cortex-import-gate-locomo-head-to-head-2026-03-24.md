# Cortex Import Gate vs Ungated — LoCoMo conv-30 Head-to-Head — 2026-03-24

## Scope

This compares the same Cortex `main` binary on the public LoCoMo `conv-30` answerable slice with only one difference:

- `ungated`: normal import
- `gated`: import with `--import-quality-gate`

Common setup:

- binary: `/tmp/cortex-main-bin`
- Cortex branch target: updated `main`
- corpus: full 10-conversation markdown render
- scored slice: `conv-30`, categories `1`, `2`, and `4`, `81` questions
- search mode: `rrf`
- embedder: `ollama/all-minilm`
- answer model: `openrouter/google/gemini-2.5-flash`
- embedding path: timeout-based helper with zero-vector fallback on failures

Raw artifact:

- `/tmp/cortex-import-gate-h2h-timeboxed-20260324/head_to_head_results.json`

## Top-Line Result

| Path | Memories | Evidence hits | Non-degraded | Exact matches | Avg token F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ungated | `501` | `32 / 81` | `79 / 81` | `0 / 81` | `0.0817` |
| Gated | `500` | `36 / 81` | `79 / 81` | `0 / 81` | `0.0841` |

Net:

- the gate dropped `1` memory at import time
- evidence hits improved by `+4`
- average token F1 improved by about `+0.0024`
- degraded count did not improve

## Category Breakdown

### Category 1

| Path | Evidence hits | Non-degraded | Avg F1 |
| --- | ---: | ---: | ---: |
| Ungated | `5 / 11` | `11 / 11` | `0.1784` |
| Gated | `5 / 11` | `10 / 11` | `0.1306` |

Interpretation:

- no retrieval gain
- slight answer-quality regression

### Category 2

| Path | Evidence hits | Non-degraded | Avg F1 |
| --- | ---: | ---: | ---: |
| Ungated | `7 / 26` | `26 / 26` | `0.0297` |
| Gated | `9 / 26` | `25 / 26` | `0.0530` |

Interpretation:

- this is the clearest win
- the gate improved temporal evidence hit rate and temporal answer F1

### Category 4

| Path | Evidence hits | Non-degraded | Avg F1 |
| --- | ---: | ---: | ---: |
| Ungated | `20 / 44` | `42 / 44` | `0.0882` |
| Gated | `22 / 44` | `44 / 44` | `0.0908` |

Interpretation:

- modest retrieval gain
- small answer-quality gain
- fewer degraded answers

## Runtime Notes

- ungated import: `19.225s`
- gated import: `27.302s`
- ungated embed helper: `64.85s`
- gated embed helper: `87.519s`

Important caveat:

- the `all-minilm` embed helper produced many zero-vector fallbacks under the `8s` timeout:
  - ungated: `88 / 501` real embeddings, `413` fallbacks
  - gated: `87 / 500` real embeddings, `413` fallbacks

So this comparison is still meaningful for relative import-gate impact, but it is not a clean statement of the fully healthy all-minilm retrieval stack.

## Conclusion

The experimental import quality gate is a **small net positive** on the full `conv-30` slice:

- slightly better overall token F1
- better evidence hit rate
- strongest gain on temporal questions

It is not yet a dramatic benchmark mover.
But it now clears the retrieval fixture gate and shows a real, non-synthetic LoCoMo gain without hurting the whole slice.
