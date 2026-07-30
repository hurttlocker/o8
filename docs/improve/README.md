# Improvement plans — 2026-07-06 audit

> **Execution record (same day):** 9 of 10 merged to main via o8 dispatch (Codex workers, refute-reviewed, ancestry-verified): 001, 003, 004, 005, 006, 007, 009, 010, plus 008. **002 parked unmerged** — two worker attempts produced speculative client patches without reproducing #1459; evidence posted on the issue; needs an interactive debugging session. Follow-ups filed: #1467 (wire isTerminalRuntimeStatus into pollers), #1456 stays open for the real Node-24 ABI fix (003 shipped the visible-error floor). Dogfood yield: #1463–#1466, #1468–#1470.

Ranked output of a five-scout `/improve` sweep (bugs, perf, debt, tests, build-next) adjudicated by Fable 5. Each plan is self-contained: an executor should need nothing beyond the plan file. Every executed plan gets a `reviewer`-agent refute pass before it counts as done. Beta-gate context: the gate is a clean 3-concurrent-mission scoring day on 0.1.555 — plans 001–004 exist to make that day scoreable.

| # | Plan | Theme | Impact | Effort | Executor |
|---|------|-------|--------|--------|----------|
| 001 | [Merge truth by ancestry](001-merge-truth-by-ancestry.md) — #1457 phantom releases + unverified worktree-gone completion + squash-blind merge check, with direction-asserting tests | correctness | HIGH | M | Opus |
| 002 | [Orchestrator silent sends post-relaunch](002-orchestrator-silent-sends.md) — #1459; sends must deliver or visibly fail | correctness | HIGH | M | Opus |
| 003 | [Node-24-only support](003-node-24-support.md) — #1456; dead-on-first-launch for Node 24 users | new-user blocker | HIGH | M | Opus |
| 004 | [claude-code lane parity](004-claude-code-lane-parity.md) — #1460 boot orphan sessions + #1461 hardcoded "Codex is working" | correctness/UI | MED-HIGH | S/M | Codex |
| 005 | [Thread-history mtime cache](005-thread-history-mtime-cache.md) — full JSON re-parse of every thread file, every second | perf | HIGH | S/M | Codex |
| 006 | [Review-diff spawn gating](006-review-diff-spawn-gating.md) — 3 git spawns × N worktrees on a 10s poll + fs-event bursts | perf | HIGH | S/M | Codex |
| 007 | [MODEL_IDS registry](007-model-id-registry.md) — model ids hardcoded in ~26 files; **time-sensitive: Fable exits 7/7** | debt | MED (urgent) | S | Sonnet/Codex |
| 008 | [orchestrator-session-core extraction](008-orchestrator-session-core.md) — diverging 1160/723-line twins; every drift is a latent bug | debt | HIGH | M/L | Opus |
| 009 | [Clipboard poison recovery](009-clipboard-poison-recovery.md) — two `lock().unwrap()` sites can wedge paste until restart | correctness | MED | S | Sonnet |
| 010 | [Regression-guard test pack](010-regression-guard-tests.md) — compactPacketLabel, isTerminalStatus classifier, normalizePacket full-key round-trip | tests | MED | S | Sonnet/Codex |

Suggested order: 007 first (deadline), then 001→004 (gate reliability), 005/006 anytime (independent), 009 anytime (trivial), 010 before or with 001, 008 last (biggest blast radius; rebases over 002).

## Adjudication notes — dropped findings

Cut for the ~10-plan cap, not because they're wrong (impact × confidence ranked lower, or superseded):

- **Merge-ancestry direction test alone** — folded into 001 as its acceptance criteria.
- **find_preferred_node_22 Rust tests** — folded into 003.
- **Silent-exit null `lastEventAt` grace bypass** (`src/lib/supervisor/silent-exit-detector.ts:598–604`) and **isPidAlive PID-reuse false positive** (`src/lib/lane/reaper.ts:50,111`) — real but low-frequency; candidates for a future reaper-robustness plan.
- **CDP attached-browser 2s refresh** (ws-server.ts:2699) and **desktop transcript virtualization** (`ChatMessageList.tsx:182`) — MED perf, rows already well-memoized; below the line.
- **ws-server.ts god-file carve-up** (5902 lines, 48 importers) — real, but L-effort and collides with 005/006; stage after those land.
- **MCP defineTool registry** and **settings-tab scaffold hook** — medium payoff refactors; queue behind 008.
- **Root-dir PNG litter** — already gitignored, untracked local files only (~13MB); `rm *.png` at leisure, no repo impact.
- **Product-track items** (onboarding single-GitHub-auth phase ②, #1342 permissions concierge, canvas intent-bus verbs #1246/#1422, e2e-in-CI decision, founding-checklist B-4/D switches) — build-next candidates, not code-improvement plans; belong on the product backlog, sequenced after the reliability trio.
