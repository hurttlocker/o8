# Implementation notes

## Plan

- Give every dispatched Claude Code carrier a worker-owned `CLAUDE_CONFIG_DIR` with no `skills` directory.
- Disable Claude Code skill discovery for packet workers and inject only operator-allowlisted repository skill instructions into the assembled prompt.
- Persist each completed Claude Code turn's input plus cache-read context count on its lane exit event.
- Prove the isolation through the real lane dispatch seam, then run the requested gates.

## Edge-case disposition

- `src/lib/data-dir-migration.ts`: set aside; preserve migration logging and failure tolerance.
- `src/lib/approvals/store.ts`: set aside; preserve throws, null sentinels, and loop exits.
- `src/lib/db/index.ts`: set aside; preserve initialization exits, migration loops, and error logging.
- `src/lib/dispatch/rules-store.ts`: set aside; repository skill allowlisting belongs to the Claude worker profile, not learned dispatch rules.
- `src/lib/lane/archive-ending.ts`: set aside; no archive or cleanup ordering changes are needed.
- `src/lib/lane/lifecycle.ts`: set aside; usage is recorded on the existing runtime exit event without changing lifecycle transitions.

## Deviations

- The real-path test enters through `claudeCodeRuntime.launch` instead of the lane command because the synthetic fixture has no managed-worktree materialization identity; it still exercises the production runtime adapter, owned-session spawn environment, persisted lane event, and assembled packet prompt without bypassing the ownership guard.
