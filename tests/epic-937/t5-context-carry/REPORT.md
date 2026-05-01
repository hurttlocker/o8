# Test 5 — Cross-runtime context carry (#942)

> **STATUS:** pending — runs only if t1 (#938) passes AND t2 (#939) Phase 2 passes

## Goal

Prove that a fact written by Codex in packet A, captured in the outcomes ledger, surfaces as cited context to Gemini executing packet B.

## Methodology

Construct 3 sentinel scenarios — different decision shapes:
1. Config value (e.g. "use 250ms debounce for this input")
2. Naming convention
3. Library choice

For each scenario:
1. Dispatch packet A to Codex with a unique sentinel decision in its commit. Let it merge.
2. Wait for the indexer to ingest the outcome (or run the seeder + indexer manually).
3. Verify via `cortex.ask` that the Brain has the fact.
4. Dispatch packet B to Gemini that touches the same area. The packet body should NOT contain the sentinel decision.
5. Inspect Gemini's resulting diff/transcript for evidence of the sentinel value being preserved or referenced.

## Pass bar

Gemini's packet B output references the sentinel decision (in code, comment, or transcript reasoning) in ≥2/3 scenarios.

## Cost budget

6 packets across Codex + Gemini, plus indexer runs (~$1).

## Scenarios

(filled in)

## Headline numbers

(filled in — sentinel preservation rate)

## Surprises

(filled in)

---

## RESULT

(filled in — `PASS | FAIL | INCONCLUSIVE | DEFERRED` + headline numbers + one paragraph analysis)
