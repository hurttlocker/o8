# 004 — claude-code worker lane parity: boot orphans (#1460) + hardcoded status copy (#1461)

## What & why
The claude-code-as-worker path (#1407, shipped 0.1.553) left two visible parity gaps, both open on GitHub and both landing squarely on the beta-gate scoring run and the standing UI-parity rule ("pills match DB, transcript renders, console clean"):

- **#1460** — at app boot, a headless loop spawned 3 orphan claude-code worker sessions. They pollute the agent rail and skew any concurrent-mission scoring (the gate metric literally counts running missions).
- **#1461** — the lane tab hardcodes "Codex is working" and shows stale state for claude-code lanes. Visible wrongness during the exact demo the gate is judged on. Small fix, high visibility.

## Exact change
1. **#1460 first** (`gh issue view 1460 -R hurttlocker/o8` for the repro): find the boot-time path that discovers/spawns claude-code sessions. Start from the startup orphan-sweep and session-discovery code (memory #1292: startup orphan-sweep exists in the lane lifecycle; the claude-code runtime adapter discovery likely re-adopts or re-spawns sessions it shouldn't). Root-fix the spawn/adoption condition — do not just sweep the orphans afterward. Keep the existing #1292 orphan-sweep behavior intact.
2. **#1461**: grep for the literal string `Codex is working` (and siblings) in `src/components` / `src/lib/workspace-terminal`. Replace with copy derived from the lane's actual worker CLI (`agentCli` / worker kind field — check `src/lib/lane/types.ts`) and fix whatever staleness makes the claude-code lane state lag (likely the status source is codex-specific; wire the claude-code adapter's status into the same field rather than special-casing the copy).

## What NOT to touch
- The dispatch pipeline invariants: orange accents + green tab + status banner + lane enrichment must stay aligned (memory: dispatch_pipeline_invariants).
- Don't rename any lane/packet fields (normalizePacket trap — fields not in `normalizePacket()` evaporate; if you add a field, add it there and in `tests/packet-control-fields-survive-normalize.test.ts`).

## Acceptance criteria (reachability-grade)
- Cold app start with no missions running → zero worker sessions appear in the rail (verify via `o8_view_*` MCP tools reading the real webview, and via the sessions dir on disk).
- Dispatch one claude-code-worker mission: lane tab copy names the right worker, status pill matches DB state through running → reviewing → terminal, no stale "working" after exit.
- #1460 and #1461 closeable with evidence.

## Verification
```bash
npm run typecheck && npm test
```
Then live via `o8_view_*`: screenshot the rail at boot, and the lane tab mid-run + post-run for a claude-code mission. **UI-touching: sweep the light/dark × transparent/opaque matrix per the `screenshot-verify` skill** for the lane tab states.

## Failure path
If the #1460 spawn source can't be pinned after 3 attempts: stop, revert, attach the boot logs + spawn stack to the issue, report. Do not paper over with an extra sweep.

## Executor tier
Codex via o8 dispatch (well-specced; #1461 is mechanical, #1460 is a bounded root-cause). Review by `reviewer` agent before done.
