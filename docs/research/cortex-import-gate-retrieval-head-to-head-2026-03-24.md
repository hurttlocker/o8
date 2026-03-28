# Cortex Import Gate vs Ungated — Retrieval-Only LoCoMo conv-30 Head-to-Head — 2026-03-24

## Scope

This compares the same Cortex `main` binary on the public LoCoMo `conv-30` answerable slice with only one difference:

- `ungated`: normal import
- `gated`: import with `--import-quality-gate`

Common setup:

- binary: `/tmp/cortex-main-bin`
- Cortex main: includes `#363` embed timeout and `#364` import quality gate
- corpus: full 10-conversation markdown render
- scored slice: `conv-30`, categories `1`, `2`, and `4`, `81` questions
- retrieval mode: `rrf`
- embedder: `ollama/all-minilm`
- scoring:
  - `hit@10`: gold answer appears in top-10 retrieved result text
  - `joined-context F1@10`: token F1 on the concatenated top-10 retrieved text vs gold answer

Raw artifact:

- `/tmp/cortex-import-gate-retrieval-h2h-helper-20260324/head_to_head_results.json`

## Top-Line Result

| Path | Memories | Denied | Hit@10 | Avg joined F1 | Timeouts / Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ungated | `501` | `0` | `6 / 81` | `0.0107` | `4` |
| Gated | `500` | `1` | `5 / 81` | `0.0102` | `8` |

Net:

- the gate dropped `1` memory at import time
- `hit@10` regressed by `-1`
- joined-context F1 regressed slightly
- timeout/error count increased

## Category Breakdown

### Category 1

| Path | Hit@10 | Avg joined F1 | Errors |
| --- | ---: | ---: | ---: |
| Ungated | `0 / 11` | `0.0235` | `0` |
| Gated | `0 / 11` | `0.0250` | `1` |

### Category 2

| Path | Hit@10 | Avg joined F1 | Errors |
| --- | ---: | ---: | ---: |
| Ungated | `1 / 26` | `0.0017` | `3` |
| Gated | `1 / 26` | `0.0019` | `3` |

### Category 4

| Path | Hit@10 | Avg joined F1 | Errors |
| --- | ---: | ---: | ---: |
| Ungated | `5 / 44` | `0.0128` | `1` |
| Gated | `4 / 44` | `0.0113` | `4` |

## Runtime Notes

- ungated import: `22.836s`
- gated import: `27.322s`
- ungated all-minilm helper embed: `95.067s`
- gated all-minilm helper embed: `119.242s`

The helper completed all embeddings:

- ungated: `501 x 384d`
- gated: `500 x 384d`

## Conclusion

The import quality gate is **not** yet a win on the retrieval-only full `conv-30` comparison.

It is:

- non-regressing on the small retrieval fixture corpus
- strong on the teacher-seeded holdout

But on the broader LoCoMo retrieval-only slice it is currently a small negative:

- worse `hit@10`
- slightly worse joined-context F1
- more timeout/error rows in the search sweep

So the honest next step is:

1. do not claim the gate improves LoCoMo retrieval yet
2. expand teacher labels around conversational/commonality chunks
3. add a second eval corpus that is closer to `conv-30` than the current ops fixture
4. rerun the same retrieval-only head-to-head after the next model update
