# Test 4 — Governance lift on weaker model (#941)

> **STATUS:** **DEFERRED — same dispatch-layer blocker as T3.**

## RESULT: **DEFERRED — could not measure**

T4's framing requires running gemini twice on the same packets — once bare (direct CLI invocation, no o8) and once governed (through o8 with directives + scaffolding). The "weaker model" the framing leans on is gemini specifically.

**Both invocation paths are blocked in this env:**
- **Bare gemini:** Works in default `gemini -p` mode but the user's tasks need stream-json output to verify outcomes. Stream-json mode requires `GEMINI_API_KEY` (user has `GOOGLE_GENERATIVE_AI_API_KEY` only — see T3 REPORT for full diagnosis).
- **Governed (o8 → gemini):** Same env-var gap.

A degraded version of T4 ("governance lift on codex" — same model, with vs without o8 scaffolding) was considered but rejected:
- Codex via o8 also blocked (hardcoded `--model gpt-5-codex` is unsupported on user's ChatGPT account — see T3 REPORT).
- Even if codex worked, "governance lift on a strong model" doesn't test the founder's stated thesis ("does scaffolding lift a WEAKER model"). It would be a different test.

## What the test would have measured (preserved for re-run)

10 packets representing real engineering work, mix of decision-density. Each run twice:
- Bare baseline: `gemini -p "<packet body>"` direct, no directives, no Brain context, no orchestrator pre-review.
- o8 governance: dispatch through o8 with full scaffolding (directive injection, Brain context, orchestrator G3 review, operator G4 review).

Score per packet: did it ship merge-ready first attempt? How many reprompts? Sonnet judge on diff quality 0-1.

Pass bar: o8 governance ships merge-ready first-attempt at ≥1.5× the bare rate.

## When this can run

Once the gemini adapter env-var gap is fixed (or the user adds `GEMINI_API_KEY` to their shell env). The test harness is straightforward:
- A bash script invoking gemini CLI directly with each packet body
- Curl HTTP calls to /api/orchestrator/create-mission for the o8 path
- A Sonnet-4.6 judge over the resulting diffs (reusing the t1-recall judge.ts pattern)

Estimated time once unblocked: ~30 min for 10 packets × 2 paths.

## Cost incurred

- $0 (no dispatches)

---

## RESULT: **DEFERRED — gated on the same adapter env-config fixes blocking T3.** When gemini's stream-json auth is sorted, this test is straightforward to execute.
