# 007 — One MODEL_IDS registry (time-sensitive: Fable exits 2026-07-07)

## What & why
Model id strings (`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `gpt-5*` variants) are hardcoded across ~26 files / ~138 occurrences in TS **and** Rust (scout sample: `src/lib/format.ts`, `src/lib/demo/fleet.ts`, `src/lib/cortex/qa/*` adapters, `src/lib/cortex/indexer/cli-probe.ts`, `src/lib/lane/codex-orchestrator-session.ts`, plus `src-tauri/src` and `cli/`). Fable 5 leaves the fleet **2026-07-07** and the default orchestrator flips to Opus 4.8 — as written, that swap is a 26-file shotgun edit with guaranteed misses (and each miss is a runtime model-not-found or a silent wrong-tier dispatch).

## Exact change
- Create `src/lib/models.ts` exporting a single `MODEL_IDS` const object (orchestratorDefault, builder, reviewer, scout, codexDefault, …role-keyed — derive the exact role set from how the ids are actually used, don't invent roles) plus the raw id constants.
- Sweep TS call sites: `grep -rn "claude-fable-5\|claude-opus-4-8\|claude-sonnet-5\|claude-haiku" src cli --include='*.ts' --include='*.tsx'` and replace literals with imports. **Exceptions — leave literal**: test fixtures asserting specific wire strings, docs, and anything in `src/lib/demo/` that intentionally freezes display copy (judge each; when the string is display-only copy, still prefer the constant).
- Rust: add a small `models.rs` mirror for the handful of `src-tauri/src` occurrences. Do NOT build codegen/sync machinery between TS and Rust — a comment in each file pointing at the other ("keep in sync with src/lib/models.ts") is the right size.
- While there, flip the orchestrator default from `claude-fable-5` to `claude-opus-4-8` **only if** the succession swap hasn't already landed by execution time — check first (`git log --oneline -20` and grep for the default).

## What NOT to touch
- Model *routing logic* (which tier gets which job) — this is a naming consolidation, not a policy change.
- `docs/` historical files.

## Acceptance criteria
- Post-sweep: `grep -rn "claude-fable-5" src cli src-tauri/src --include='*.ts' --include='*.tsx' --include='*.rs' | grep -v models | grep -v test | grep -v demo` returns zero (analogous greps for the other ids return only the registry + justified exceptions, each with a one-line justification in the PR/report).
- Changing one constant in `models.ts` provably changes the dispatched model (drive one real dispatch in dev and observe the model id in the session/logs).

## Verification
```bash
npm run typecheck && npm test
cd src-tauri && cargo check
```
Then one live dispatch in dev confirming the model id flows from the registry.

## Failure path
If a call site's literal turns out to be load-bearing in a non-obvious way (wire protocol, external API enum): leave it literal with a comment, list it in the report. If more than ~5 such sites appear, stop and report — the registry design may need a second shape.

## Executor tier
Sonnet or Codex via o8 dispatch (mechanical sweep with clear exceptions). Review by `reviewer` agent before done.
