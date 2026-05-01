# Test 1 — Brain recall vs naive grep vs long-context (#938)

> **STATUS:** complete

## RESULT: **FAIL**

| Path | factual_avg | citation_avg | specificity_avg |
|---|---|---|---|
| Brain      | **0.13** | **0.10** | **0.19** |
| Grep+LLM   | 0.34 | 0.25 | 0.30 |
| Long-ctx   | 0.30 | 0.05 | 0.30 |

| Pairwise (Brain wins ≥2 of 3 axes per case) | Wins | Pass bar (≥7/10) |
|---|---|---|
| Brain vs Grep+LLM | **1/10** | FAIL |
| Brain vs Long-ctx | **2/10** | FAIL |

The Brain loses, decisively, on every aggregate axis to both baselines. The thesis it was built on — that BM25-over-distilled-facts beats grep — is **falsified on this 10-question battery against the current substrate**. Per the founder's stop rule (#938 prompt), Tests 2-6 of the epic wait until the substrate is addressed.

## Why it failed (substrate inspection)

```
sqlite> SELECT source_kind, count(*) FROM facts GROUP BY source_kind;
github_comment | 1416   ← 71% of all facts
issue          |  518   ← 26%
doc            |   28   ← 1.4%   (CLAUDE.md alone is 35 KB / hundreds of distinct claims)
outcome        |   12   ← 0.6%
pr             |   12   ← 0.6%   (out of ~50 recent PRs)
directive      |    9   ← 0.5%
```

The substrate is overwhelmingly comment-distillation. Doc / PR / outcome / directive facts are critically thin. CLAUDE.md is **ingested** in `docs` (35 KB body) and present in `docs_fts`, but only 28 distilled facts cover all 6 markdown sources combined — meaning a question like "what's the data dir override env var" hits the docs FTS retriever, but the BM25 ranker prefers the higher-priority FACT- rows from comments which don't address the question, and the composer over-trusts those FACT- rows.

The smoke:qa gate continues to pass 6/6 because its 6 cases were hand-picked from categories with known good substrate coverage. Smoke passing does **not** contradict this finding — it only certifies the 6 specific cases.

## Methodology

10 questions mined from real recent operator work (last week of issues #960-971, PRs #944-980, commits c7940062..a27bf484). Mix:

- **3 docs-favored** (answer is literally in CLAUDE.md / DESIGN.md): data-dir env var, 44px touch target, ship sequence.
- **7 PR/commit-favored** (answer lives in PR bodies / commit messages / source comments): OpenRouter timeout bump, eval-mode tier 0 model, 300s Sonnet timeout, daily compactor, fs.watch on docs, ownership-regression rows.slice fix, source_authority hierarchy.

Three retrieval paths per question, **same final synthesis model (Sonnet 4.6 via OpenRouter)** to isolate retrieval quality:

- **(a) Brain** — `askCortex()` in eval mode, full pipeline: classifier → 4-retriever fan-out (facts, sql, fts, graph) → unionMerge → Sonnet 4.6 composer with `[BRACKET-ID]` citation discipline.
- **(b) Grep+LLM** — keyword-tokenize the question (filter stopwords), `rg -i -F -A 2 -B 1` across CLAUDE.md/README.md/AGENTS.md/DESIGN.md/docs/*.md, take top 5 hits by token-match-count, hand to Sonnet 4.6 with the question.
- **(c) Long-ctx** — single Sonnet 4.6 call with the entire CLAUDE.md (35 KB) + DESIGN.md (21 KB) concatenated as context. No retrieval pipeline, no grep.

Sonnet 4.6 judge (10 calls, one per question, all 3 paths in one call with shuffled A/B/C labels) scored each candidate independently against the reference answer on three axes: factual_accuracy, citation_correctness, specificity. Each axis 0.0-1.0.

## Per-question detail

| Case | Favored | Brain (f/c/s) | Grep (f/c/s) | LongCtx (f/c/s) | Brain wins ≥2 axes |
|---|---|---|---|---|---|
| t1-q01 data-dir env var | docs | 0/0/0 | 1.0/0/1.0 | 1.0/0/1.0 | — |
| t1-q02 44px touch target | docs | 0.5/0/1.0 | 1.0/0/1.0 | 1.0/0/1.0 | — |
| t1-q03 release sequence | docs | 0.5/0.5/0.5 | 1.0/1.0/1.0 | 1.0/0.5/1.0 | — |
| t1-q04 OpenRouter 10→25s | pr-commit | 0/0/0 | 0/0/0 | 0/0/0 | tie (all 0) |
| t1-q05 eval tier-0 model | pr-commit | 0.1/0/0.1 | 0.2/0.5/0 | 0/0/0 | vs LongCtx (factual+specificity) |
| t1-q06 Sonnet 300s timeout | pr-commit | 0.2/0.5/0.3 | 0/0/0 | 0/0/0 | **vs both (only Brain win)** |
| t1-q07 daily compactor | pr-commit | 0/0/0 | 0/0.5/0 | 0/0/0 | — |
| t1-q08 fs.watch on docs | pr-commit | 0/0/0 | 0.2/0.5/0 | 0/0/0 | — |
| t1-q09 rows.slice fix | pr-commit | 0/0/0 | 0/0/0 | 0/0/0 | tie (all 0) |
| t1-q10 source_authority | pr-commit | 0/0/0 | 0/0/0 | 0/0/0 | tie (all 0) |

## Surprises

1. **Brain loses on docs-favored questions** where the answer is literally in CLAUDE.md and the docs FTS retriever has the row indexed. Expected behavior: Brain ties or wins because it has a structured retrieval pipeline. Actual: Brain says "I don't have that information yet" on q01 (CORTEX_IDE_DATA_DIR — present at CLAUDE.md:111 and CLAUDE.md:316 in the indexed docs body) and gives a partial answer on q03 (`npm version patch && npm run ship` while missing `git push --follow-tags`). The retriever is finding wrong-topic FACT- rows and the composer is over-trusting them.
2. **Brain hallucinates wrong-topic facts on PR/commit questions.** q08 (fs.watch on docs) — Brain returned a fact about `fs.watch` on Codex JSONL files (a different feature, issue #157) instead of the docs feature (issue #964). q07 (compactor) — Brain returned a fact about dispatch rule promotion (a learned pipeline) instead of the facts-table compactor jobs. The retriever's BM25 over distilled facts ranks tangentially-related rows higher than the actual answer when the answer isn't in the substrate.
3. **All three paths fail q04, q09, q10** — these answers live ONLY in source-code comments inside `composer.ts` and in PR body text. None of the three paths ingest source-code comments or PR descriptions deeply enough. Brain is supposed to fix this gap; on this battery it does not.
4. **Long-context Sonnet 4.6 (path c) is roughly tied with grep+LLM** on docs-favored questions and equally helpless on PR/commit-favored. Stuffing the model with the whole CLAUDE.md isn't a substitute for indexed knowledge of recent commits/PRs — but it's also not worse than grep on the docs questions, which is interesting.
5. **q06 is the one Brain win.** It returned a fact about Class B latency budget (2.0s TTFT, 4s TTLT, 6s ceiling) that's correct adjacent context — different from the reference answer (300s timeout rationale) but the judge gave it partial credit on factual+specificity because it cited a real Class B fact. The retrieval pipeline pulled correct neighborhood rows; the reference answer lives in a code comment that wasn't ingested.

## Recommended interpretation

- **The multi-harness control plane thesis (#937) is NOT falsified by this test.** Test 1 measures the Brain's retrieval, which is a substrate concern. Tests 2-6 measure runtime coordination, mid-packet substitution, parallel dispatch, governance lift, MCP composition — all of which can succeed even with a thin substrate.
- **However, the founder's stop rule for #938 says: "we have a substrate problem and the rest of the epic waits."** Tests 2-6 are deferred until either (a) the substrate gap is addressed by deeper PR/commit/source-comment ingestion, OR (b) the founder explicitly chooses to proceed with tests that don't depend on substrate quality (#939 #940 #943 #941; #942 directly does and would FAIL by transitivity).
- **What to publish in Notes 05/07 from this test:** the substrate thinness numbers (28 doc-facts / 12 PR-facts / 9 directives out of 1995 total, with comments at 1416). The pass-bar number (1/10 and 2/10) shows that BM25-over-distilled-facts is currently weaker than grep — a credible benchmark only if the founder is comfortable publishing the diagnosis honestly. Otherwise, hold this for an internal substrate-fix session.

## Cost incurred

- Path (a) Brain: 10 × Sonnet 4.6 OpenRouter → ~$0.26
- Path (b) Grep+LLM: 10 × Sonnet 4.6 (small ctx) → ~$0.10
- Path (c) Long-ctx: 10 × Sonnet 4.6 (35K+21K char ctx) → ~$0.50
- Judge: 10 × Sonnet 4.6 (multi-answer prompt) → ~$0.10
- **Total Test 1: ~$0.96**

## Smoke gate

- Pre-test: PASS 6/6 (33986ms total, p50 5.3s)
- Post-test: PASS 6/6 (20450ms total, p50 3146ms) — env unchanged.
