## Deviations

- `src/lib/agents/store.ts` does not exist in this worktree; the current normalize chokepoint is `src/lib/orchestrator/store.ts`.
- Claude Code has no fast safe `doctor` auth check here: `claude doctor` exceeded the 2s budget, so auth detection uses the existing credentials file shape plus env-key presence.
