# Test 2 — Harness substitution mid-packet (#939)

> **STATUS:** **DEFERRED** — Test 1 (#938) FAILED at 1/10 vs Grep (pass bar 7/10). The founder's stop rule on #938 says "the rest of the epic waits." This test is technically orthogonal (it measures runtime coordination, not Brain retrieval) and could still be run, but is held pending founder direction on whether to proceed.

## Goal

Prove the multi-harness thesis by swapping a runtime mid-dispatch and confirming state survives.

## Methodology — Phase 1 (validation, free)

Hand-craft ONE scenario. Dispatch a small packet to Codex (e.g. "add a one-line console.log to file X"). At the 50% mark — Codex has accepted the packet and started but hasn't finished — interrupt it via the orchestrator, swap the runtime to opencode, redispatch the same packet against the same worktree.

Verify:
- Lanes table state survives (`SELECT * FROM lanes WHERE id = ?`).
- Directives are still loaded into the new dispatch's context.
- Operator approval gate fires once at the end (not twice).
- Audit trail in `session_outcomes` correctly attributes both the Codex attempt and the opencode completion.

## Methodology — Phase 2 (publishable, 5 scenarios)

Run 5 distinct mid-packet swaps across different (source, target) pairs:
- Codex → Gemini
- Codex → opencode
- Gemini → Codex
- Gemini → opencode
- opencode → Gemini

Each scenario uses a small task (≤20-line diff). Score: % that complete cleanly with state intact.

## Pass bar

Phase 1 mechanism works (binary). Phase 2 ≥4/5 scenarios complete with state intact. If both pass → multi-harness thesis confirmed. If Phase 1 fails, surface immediately and don't run Phase 2.

## Cost budget

Phase 1: one Codex packet + one opencode packet (~$0.10). Phase 2: 10 packets total. Mostly free if weighted toward Gemini and opencode; Codex ≤$1-2 max.

## Phase 1 result

(filled in)

## Phase 2 results

(filled in — table of 5 scenarios × outcome)

## Surprises

(filled in)

---

## RESULT

(filled in — `PASS | FAIL | INCONCLUSIVE` + headline number + one paragraph analysis)
