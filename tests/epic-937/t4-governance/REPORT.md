# Test 4 — Governance lift on weaker model (#941)

> **STATUS:** **DEFERRED** — Test 1 (#938) FAILED. Founder stop rule. This test indirectly depends on Brain quality (via "ledger context injection") but the directive scaffolding alone is independently testable.

## Goal

Prove that o8's governance scaffolding (directives in context, orchestrator pre-review at G3, ledger context injection) makes a weaker model ship merge-ready code at a higher rate than the same model alone.

## Methodology

Pick 10 packets representing real engineering work, mix of decision-density (some tightly constrained by directives, some loose).

Run twice:
- **Bare baseline** — dispatch to Gemini CLI directly via the `gemini` binary, no o8 — packet body only, no directive injection, no Brain context, no orchestrator pre-review. Operator reviews raw output.
- **o8 governance** — dispatch the same packets through o8 with full scaffolding (directives loaded, Brain context injected, orchestrator G3 review, operator G4 review).

Measure for each:
- Did the packet ship merge-ready on first attempt?
- How many reprompts needed before it shipped?
- Quality of the diff (Sonnet judge on 0-1).

## Pass bar

o8 governance mode ships merge-ready first-attempt at ≥1.5× the bare rate. If yes → wrapper-beats-model story is concrete with Gemini specifically named.

## Cost budget

Mostly Gemini quota (generous default). ~20 packets total. Should cost <$0.50 in real money if Gemini quota holds.

## Bare baseline

(filled in)

## o8 governance

(filled in)

## Headline numbers

(filled in — first-attempt rate × reprompts × judge score, both runs)

## Surprises

(filled in)

---

## RESULT

(filled in — `PASS | FAIL | INCONCLUSIVE` + headline numbers + one paragraph analysis)
