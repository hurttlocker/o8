# Epic #937 — Multi-Harness Control Plane Validation

Validation harness for the thesis: **o8 implements zero of the in-loop harness components and operates as the multi-harness control plane** — the layer above Cursor / Claude Code / Codex CLI / Cline that coordinates across them.

Each child issue (#938-#943) gets a folder with a REPORT.md, raw outputs (JSON / transcripts), and any scratch scripts.

## Order

1. **t1-recall** (#938) — Brain recall vs naive grep vs long-context. Most diagnostic; runs first.
2. **t2-substitution** (#939) — Mid-packet runtime swap. Phase 1 mechanism check, then 5-scenario sweep.
3. **t3-parallel** (#940) — N parallel packets across heterogeneous runtimes vs serial baseline.
4. **t4-governance** (#941) — o8 governance scaffolding lifts a weaker model's merge-ready rate.
5. **t5-context-carry** (#942) — Cross-runtime sentinel decision propagation. Runs only if t1 + t2 pass.
6. **t6-mcp** (#943) — External MCP client drives full o8 dispatch lifecycle.

## Conventions

- All work on branch `epic-937-validation`. Never push without founder asking.
- Commit format: `test(<test-id>): <short note>`.
- Smoke gate (`npm run smoke:qa`, OPENROUTER_API_KEY required) must remain 6/6 across every test.
- Codex usage is budget-constrained — Gemini and opencode carry default load.
- Each REPORT.md ends with a final `RESULT: PASS | FAIL | INCONCLUSIVE` block once the test is done.

## Baseline

- Smoke pre-test: **PASS 6/6** (33986ms total, p50 5.3s) — captured 2026-04-30 evening.
- Brain DB: `~/.o8/cortex-ide.db` schema v20, 1995 facts.
- All 4 CLIs on PATH: claude 2.1.123, codex 0.121.0, gemini 0.38.2, opencode 1.4.3.
