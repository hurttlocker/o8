# Cortex Combined LoCoMo Benchmark (2026-03-22)

## Summary

This rerun used `hurttlocker/cortex` `main` after all three branches were merged, rebuilt locally as `/tmp/cortex-combined` from commit `4da4d21` (`Merge pull request #350 from hurttlocker/feat/honcho-steal-entity-scope`).

Headline numbers on the public `conv-30` slice (`81` answerable questions):

| Path | F1 | EM | Avg latency | Degraded |
| --- | ---: | ---: | ---: | ---: |
| Previous honest `cortex answer` baseline | `7.61%` | `0.00%` | `5,522 ms` | `1` |
| Temporal Phase A+B branch | `8.93%` | `0.00%` | not re-measured here | `0` |
| Combined `main` `cortex answer` | `6.82%` | `0.00%` | `3,774 ms` | `0` |
| Combined `main` `cortex ask` | `11.42%` | `0.00%` | `5,969 ms` | `13` |

Net:

- `cortex answer` regressed vs both earlier baselines.
- `cortex ask` is now the best end-to-end path on this slice, beating the original honest baseline by `+3.81` F1 and the temporal branch by `+2.49` F1.
- Exact match is still `0.00%` across both synthesis paths, so answer form is still a real gap.

## Methodology

This reused the same conv-30 methodology as the earlier runs:

- Dataset: public `locomo10.json` at `/tmp/locomo-benchmark-src/data/locomo10.json`
- Corpus conversion: all 10 conversations rendered to markdown with session headers and original `D#:##` dialog ids
- Fresh DB: `/tmp/cortex-locomo-combined-2026-03-22/cortex.db`
- Import command:

```bash
/tmp/cortex-combined --db /tmp/cortex-locomo-combined-2026-03-22/cortex.db \
  import /tmp/cortex-locomo-combined-2026-03-22/corpus \
  --recursive \
  --extract \
  --no-enrich \
  --no-classify
```

- Embeddings: `openrouter/text-embedding-3-small`
- Waited for embedding coverage to reach `100%` before evaluation
- Slice scored: `conv-30`, `81` questions, excluding category `5`
- Scoring: same Porter-stem F1 / set-style EM scorer used in the earlier benchmark notes

Commands used for the two synthesis paths:

```bash
/tmp/cortex-combined --db /tmp/cortex-locomo-combined-2026-03-22/cortex.db \
  answer "<question>" \
  --mode hybrid \
  --limit 5 \
  --embed openrouter/text-embedding-3-small \
  --model openrouter/google/gemini-2.0-flash-001 \
  --json
```

```bash
GOOGLE_API_KEY=... /tmp/cortex-combined \
  --db /tmp/cortex-locomo-combined-2026-03-22/cortex.db \
  ask "<question>" \
  --mode hybrid \
  --budget 1200 \
  --model google/gemini-2.5-flash \
  --embed openrouter/text-embedding-3-small \
  --json
```

## Retrieval Context

I also reran the retrieval-only summary on the same fresh DB:

| Mode | Top-1 hit | Top-5 hit | Evidence recall | Answer hit | Avg latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| BM25 | `46.91%` | `67.90%` | `63.74%` | `32.10%` | `151 ms` |
| Hybrid | `29.63%` | `60.49%` | `56.73%` | `27.16%` | `2,726 ms` |

For this run, merged `main` did not improve the raw `conv-30` hybrid retrieval slice relative to the earlier quick-wins / temporal runs. The improvement came from the new synthesis path, not from better top-5 retrieval on this slice.

## Category Breakdown

Important caveat: this public `conv-30` slice only exercised categories `1`, `2`, and `4` in this run. It did **not** include category `3`, so it cannot validate multi-hop gains directly.

| Category | Meaning | `cortex answer` F1 | `cortex ask` F1 |
| --- | --- | ---: | ---: |
| `1` | single-hop/shared attributes | `19.00%` | `15.61%` |
| `2` | temporal | `1.40%` | `15.40%` |
| `4` | open-domain | `6.97%` | `8.01%` |

Interpretation:

- The `ask` win is mostly a temporal win. Category `2` moved from `1.40%` to `15.40%`.
- `ask` did not beat `answer` on category `1` in this slice.
- Category `4` improved modestly.

## Quality Notes

### `cortex answer`

The merged `answer` path was faster and no longer degraded, but it often produced long paraphrastic responses that scored poorly under LoCoMo F1. Example pattern:

- question asks for a time/date
- retrieved evidence is in the right neighborhood
- answer responds with a full narrative paragraph instead of the benchmark’s normalized answer form

That behavior explains how latency and degraded count improved while F1 still dropped to `6.82%`.

### `cortex ask`

`ask` produced shorter and more benchmark-shaped answers, especially for temporal questions. It still had `13` degraded responses:

- `12` with `citation_integrity_failed`
- `1` with `llm_error`

Even with those fallbacks, the budgeted synthesis path still outperformed `answer` by `+4.60` F1 on the same corpus and scorer.

`ask` packing stats:

- average candidate pool before packing: `49.63`
- average packed tokens: `449.65`
- average citation count: `1.94`

## Takeaways

1. The best combined mainline LoCoMo number on `conv-30` is now `11.42%` F1 through `cortex ask`, not `cortex answer`.
2. The merged `answer` path should not be used as the headline benchmark right now. It regressed to `6.82%` F1 despite cleaner runtime behavior.
3. The new `ask` path appears to be buying most of its gain through better temporal answer shaping, not through a retrieval breakthrough.
4. This slice does not cover category `3`, so any claim about multi-hop improvement still needs a broader or category-targeted rerun.
5. The next product-path fix should likely target citation integrity in `ask` and answer-form discipline in `answer`.

## Repro Notes

- Built binary: `/tmp/cortex-combined`
- Raw results: `/tmp/cortex-locomo-combined-2026-03-22/combined_results.json`
- Fresh DB: `/tmp/cortex-locomo-combined-2026-03-22/cortex.db`
- Temporary corpus: `/tmp/cortex-locomo-combined-2026-03-22/corpus`
