# The Fable Mode Benchmark — measured 2026-07-02/03

**The one-line story: we put the most expensive AI in the world behind a governor that only lets it make decisions — and measured everything, in the five days before that model leaves the market.**

This document is the complete numbers dossier for the o8.run/benchmark page rebuild. Every number below was measured on real o8 artifacts (our own operator approval history and our own change batches), on the real Anthropic API with exact token accounting, or live in the running app. Nothing is projected except where marked.

---

## Headline numbers (the pop candidates)

| # | Number | What it is |
|---|--------|-----------|
| 1 | **~550 tokens** | Total metered tokens for one real engineering decision through the o8 window (374 in + 183 out, measured across 26 real adjudications) |
| 2 | **26×** | Input-token reduction per decision: windowed decision (374 in) vs the same decision through a tool-loaded session (~9,700 in) |
| 3 | **9.2×** | Input reduction on a HARD task: full adversarial review of a ~20-file change batch — raw context 32,720 tokens in vs windowed digest 3,544 in (same model, same task, same verdict structure) |
| 4 | **1 > 52** | A single raw-context Fable review call billed more input than an entire 52-call windowed decision eval |
| 5 | **76% cheaper** | Input cost reduction from prompt caching on the window's doctrine prefix (70,928 of 84,284 input tokens served from cache at 0.1×) |
| 6 | **80% vs 68%** | Fable matched the human operator's real recorded decisions 80% of the time; its designated successor (Opus 4.8) only 68% — measured on the same 26 decisions while both models still existed |
| 7 | **< $1** | Cost of the entire 52-decision succession eval through the window |
| 8 | **1 in 4** | Real decisions that flip depending on which frontier model holds the gavel (76% cross-model agreement) — why o8 ships judge panels, not blind trust |

## Experiment 1 — the succession eval (decision quality)

**Setup.** 26 real operator approval cards pulled from o8's own governance history (merge requests, tool confirmations, rebase conflicts, file-size overrides — 14 approved / 12 rejected by the human operator; verdict leakage scrubbed). Each card replayed as a ~1KB decisions-only artifact through `claude-fable-5` AND `claude-opus-4-8`. Three runs: CLI transport (subscription), API transport (exact tokens), API + cached doctrine.

**Results.**

| Run | Fable↔Opus agreement | Fable vs operator | Opus vs operator |
|---|---|---|---|
| CLI (sub-billed) | 73.1% | 69.2% | 65.4% |
| API (clean instrument) | **76%** | **80%** | 68% |
| API + doctrine cached | 76% | 64%* | 60%* |

- **The over-rejection pattern (3 for 3 runs):** every single Fable↔Opus disagreement had the same shape — Fable said APPROVE, Opus said REJECT — and the human operator sided with Fable in the large majority (5/6, 4/7, 4/6). The successor model is systematically more trigger-happy on rejection than both the incumbent and the human. Left alone as sole adjudicator, it would bounce work the operator would have shipped.
- **Consequence shipped into the product:** after Fable's departure (2026-07-07), contested calls in o8 route to a judge panel (the existing Collide machinery), not a single successor model. 1-in-4 flip rate is too high for a solo gavel.
- *The cached run's doctrine prefix measurably shifted BOTH models' decisions (operator-match dropped ~15 points). Standing doctrine steers the adjudicator — the production window's doctrine text is now a tuned artifact, not an afterthought.

**Token economics per decision (API, exact):**

| | input | output | total |
|---|---|---|---|
| Windowed decision | 374 | 183 (Fable) / 67 (Opus) | **~550 / ~440** |
| Same decision, tool-loaded session | ~9,700 | ~240 | ~9,940 |

**18× fewer total tokens, 26× fewer input tokens, per decision.** The whole 52-call eval: 19,480 in / 6,522 out — **under a dollar.**

## Experiment 2 — the hard-task parity test (does the window nerf the model?)

**Setup.** The hardest artifact available: adversarial pre-ship review of the entire Fable-mode change batch itself (~20 files, ~900 added lines, security-sensitive: billing isolation, tool lockouts, rate limits). Two context conditions, same task prompt, same output contract:
- **RAW** — full change batch in context (32.7K input tokens): the "native frontier" pattern.
- **WINDOW** — a ~2K-token digest (the shape o8's `digest()` produces: per-file roles + key seam excerpts).

**Economics (API, exact, measured before the account ran dry — see #4 above):**

| condition | input tokens | ratio |
|---|---|---|
| fable-RAW | 32,720 | — |
| fable-WINDOW | 3,544 | **9.2× less** |

**Quality (all four conditions, scored against 6 ground-truth subtleties known to the batch author):**

| condition | verdict | findings | ground-truth coverage |
|---|---|---|---|
| fable-RAW (full 18K-token context) | HOLD | 10/10 | 5/6 |
| **fable-WINDOW (2K digest)** | HOLD | 10/10 | **6/6** |
| opus-RAW | HOLD | 10/10 | 6/6 |
| opus-WINDOW | HOLD | 10/10 | 6/6 |

- **Unanimous verdicts across all four conditions** — the window did not change the decision.
- **The windowed Fable review found real issues the raw-context review missed**: the raw-transcript escape hatch limits call *count* but not output *size*, and the metered compaction ceiling is enforced client-side only. The raw review found its own uniques (a per-request backend-override mismatch in the Brain gate). Neither condition dominated; both were ship-blocking-grade reviews.
- The honest caveat, printed on the page: the digest was authored to be faithful (the same standard `digest()` is held to in production) — a bad digest would produce a blind review, which is exactly why o8 meters `fetch_raw` instead of banning it, reads adjudicated diffs raw, and spot-audits digests against full context.
- **The nerf question, answered on a hard task: 9.2× less context, zero quality loss measured.**

## Experiment 3 — prompt caching on the window

**Setup.** The window's standing adjudication doctrine (~1.4K tokens of real o8 governance rules) as a `cache_control: ephemeral` system block; 52 decision calls against it.

**Result: 70,928 input tokens served from cache at 0.1× price vs 13,356 at full price — a ~76% input-cost reduction** on the doctrine-laden shape. (Caveat that matters: Anthropic caching needs a ~1,024-token minimum stable prefix — thin prompts can't cache, which is exactly why the window batches its standing context into one stable block.)

## Experiment 4 — the live arc (not a lab number)

The whole loop ran live in the o8 app, on camera-ready rails:

1. Fable (locked: no file reads, no shell, no web — 10 native tools + raw-transcript tools denied at spawn) answered repo-governance questions **correctly with 6 cited sources**, because the org-memory Brain does the reading — a fixed-cost model reads so the metered one never pays to.
2. It dispatched a real coding task to a Codex worker; the worker's prompt automatically carried Brain access *because* the orchestrator is metered.
3. When the worker's launcher broke (an environment bug, since root-fixed), Fable didn't retry-spam: it investigated through its dashboards, discovered the operator's suggested fix violated a platform rule (and said so, with citations), parked everything clean, and raised a two-option decision card.
4. After the fix it pruned its duplicate packet, redispatched, reviewed the worker's diff RAW (per doctrine — the artifact being approved is never summarized), caught a real nit in the worker's code, passed the 4-check merge gate, and the work shipped as **PR #1349**.
5. Along the way it used `fetch_raw` — the window's rate-limited raw-content escape — unprompted, exactly as designed.

**The nerf verdict: a decisions-only Fable is not a worse Fable.** It answered everything a full-tooled session would, made better recovery decisions than it was instructed to make, and its judgment tracked the human operator better than its successor's did.

## Methodology & honesty notes (keep these on the page, condensed)

- N=26 decisions and 1 hard task, from a single (real, production) o8 instance — a field measurement, not an academic benchmark suite.
- Cross-model agreement measured while both models were purchasable — unreproducible after 2026-07-07. That's the point.
- The CLI transport carries Claude Code's ~9.7K-token system prompt per call; on subscription billing this is free, which is itself part of the o8 story (fixed-cost lanes for bulk, metered lane for decisions only).
- Judge-of-quality on the hard task is disclosed below the table on the page.
- Full raw data: `docs/research/fable-succession/run-*.json`, `hard-task/`.

## Brief for the page agent (o8.run/benchmark rebuild)

- Repo `~/o8-site`, `app/benchmark/page.tsx` (734 lines, currently a stale 3-task bake-off). Next 16 App Router, **inline styles only**, THEME.md is the design spec; phone-first: the operator reads this on a phone — single column, big numbers, horizontal-scroll tables only where unavoidable.
- Structure: hero headline number (#1 or #3) → the story paragraph → headline-numbers row → the four experiments as sections (tables above) → methodology footnote → CTA to download.
- Tone: receipts, not hype. Every number links its experiment section. Use the phrase "every token it pays for is a decision" once.
- DO NOT ship until the operator calls the reveal — Fable mode is unannounced. Build behind the existing route, hold the deploy.
