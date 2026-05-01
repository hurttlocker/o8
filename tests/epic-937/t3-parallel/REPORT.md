# Test 3 — Multi-runtime parallel dispatch (#940)

> **STATUS:** **DEFERRED** — Test 1 (#938) FAILED. Founder stop rule. This test is orthogonal to Brain retrieval and could still be run independently.

## Goal

Show that dispatching N packets in parallel across heterogeneous runtimes ships more aggregate value per wall-clock minute than serial dispatch through any single runtime.

## Methodology

Pick 6 small independent packets from the issue backlog (must be independent — no merge conflicts).

Run twice:
- **Serial baseline** — all 6 dispatched to the best single runtime (probably Codex), back-to-back, one at a time.
- **Parallel multi-harness** — 6 dispatched simultaneously, distributed: 2 to Codex, 2 to Gemini, 2 to opencode.

Measure:
- Total wall-clock time
- Completion rate
- Number of orchestrator-review reprompts needed
- Number of operator rejections

## Pass bar

Parallel total wall-clock < 0.6 × serial wall-clock AND completion rate within 10% of serial.

Cost story to publish if pass: *o8 makes 6 packets ship in the time it takes one runtime to ship 3-4.*

## Cost budget

12 packets total. Cap Codex at 4 packets across the whole test (2 in serial, 2 in parallel) — Gemini + opencode carry the rest.

## Serial baseline

(filled in)

## Parallel multi-harness

(filled in)

## Headline numbers

(filled in — wall-clock × completion rate × reprompts × rejections, both runs)

## Surprises

(filled in)

---

## RESULT

(filled in — `PASS | FAIL | INCONCLUSIVE` + headline numbers + one paragraph analysis)
