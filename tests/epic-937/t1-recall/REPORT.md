# Test 1 — Brain recall vs naive grep vs long-context (#938)

> **STATUS:** in progress

## Goal

Prove (or disprove) that the Brain's BM25-over-distilled-facts retrieval beats grep-over-CLAUDE.md on real questions.

## Methodology

Build a 10-question test set from real recent operator work (last week of issues / PRs / commits that the founder actually navigated).

For each question, run three retrieval paths:
- **(a) cortex.ask (Brain)** — current pipeline, OpenRouter Sonnet 4.6 composer (eval mode).
- **(b) Naive grep** over the founder's repo's CLAUDE.md, README.md, AGENTS.md, DESIGN.md, docs/*.md — surface top 5 hits, hand-construct an answer.
- **(c) Long-context Sonnet 4.6** OpenRouter call with the entire CLAUDE.md + DESIGN.md as context, asked the question — single call, no retrieval pipeline.

Score each answer on three axes (0-1):
- **Factual accuracy** — does the answer match the truth? Sonnet 4.6 judge using `tests/qa-eval/judge.ts` pattern.
- **Citation correctness** — did the answer cite the right source row? (a) has citation handles; (b) and (c) checked for verbatim excerpts.
- **Specificity** — did the answer include the concrete value asked for (a number, a name, a path), or did it generalize?

## Pass bar

Brain (a) wins on at least 2 of 3 axes across at least 7 of 10 questions vs **both** baselines. If yes → Brain is genuinely additive over alternatives. If no → substrate problem; rest of the epic waits.

## Cost budget

~30 OpenRouter calls (10 × 3 paths) + 10 judge calls = ~$1.

## Question selection

(filled in during run — see `data/questions.json`)

## Raw outputs

(filled in during run — see `data/runs.json` and per-question subfolders)

## Headline numbers

(filled in once all 10 questions scored)

## Surprises

(filled in when test completes)

---

## RESULT

(filled in when test completes — `PASS | FAIL | INCONCLUSIVE` + headline numbers + one paragraph analysis)
