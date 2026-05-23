# Repository Guidelines

## Project Structure & Module Organization
`src/app` contains the Next.js App Router pages and API routes. `src/components` holds UI surfaces, with major splits for `desktop`, `mobile`, and `landing`. Shared logic lives in `src/lib` by domain (`runtime`, `worktree`, `openclaw`, `cortex`, `review`, etc.). `src/ws-server.ts` runs the standalone WebSocket bridge used by the mobile shell. Native desktop packaging lives in `src-tauri`. Product notes, specs, and architecture docs live in `docs`; static assets are in `public` and `assets`.

## Brand Direction
Read [`BRAND.md`](./BRAND.md) before making desktop or mobile visual changes. It defines the current product theme, spacing, color, motion, and component language.

## Build, Test, and Development Commands
Use `npm install` to sync dependencies.

- `npm run dev`: starts Next.js on `http://localhost:3001`
- `npm run dev:ws`: starts the WebSocket server on port `3002`
- `npm run desktop:dev`: runs the web app and WS server together for normal UI work
- `npm run build`: creates the production Next.js build
- `npm run start`: serves the production build on port `3001`
- `npm run lint`: runs ESLint across the repo
- `npm run typecheck`: runs strict TypeScript checks with `tsc --noEmit`
- `npm run tauri:dev` / `npm run tauri:build`: run or package the native Tauri shell

## Coding Style & Naming Conventions
This repo uses TypeScript in `strict` mode and the Next.js ESLint flat config in [`eslint.config.mjs`](./eslint.config.mjs). Match the existing style: 2-space indentation, single quotes, semicolons, and concise comments only where the flow is not obvious. Use `PascalCase` for React components (`DesktopChat.tsx`), `camelCase` for functions and utilities, and keep domain files grouped under `src/lib/<domain>`. Prefer the `@/` path alias over long relative imports.

## Testing Guidelines
No automated test runner is configured yet. For every change, run `npm run lint` and `npm run typecheck`, then smoke-test the affected routes, especially `/`, `/dashboard`, `/landing`, and `/mobile` when UI behavior changes. Validate API and WS changes with the local bridge running via `npm run desktop:dev` or `npm run dev:ws`.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:` and `fix:`. Keep commits focused and imperative, for example `fix: prevent stale mobile transcript replay`. PRs should include a short problem/solution summary, linked issue or design doc when relevant, and manual verification steps. Include screenshots or recordings for desktop/mobile UI changes and note any required env vars in `.env.local` such as `WS_TOKEN`, `GEMINI_API_KEY`, or `VERCEL_TOKEN`.

## o8 CLI (available inside packet worktrees)

When you're an agent dispatched into an o8 packet worktree, the `o8` CLI is on `$PATH` (symlinked to `/usr/local/bin/o8` once o8.app has run at least once). Use it instead of curling the local HTTP API — it knows your packet context and resolves cwd automatically.

```
o8 status                              # global fleet snapshot (running packets, lanes, merges, approvals)
o8 version                             # CLI + connected server version
o8 doctor [--reap]                     # verify port/token resolution + ping; --reap clears zombie lanes

# Packet (your dispatched work) — most auto-resolve the lane from cwd
o8 packet info                         # current packet metadata (id, branch, base, runtime, recent events)
o8 packet scope [packet-id]            # one-call worker context: file ceiling, allowed/blocked paths, directives, related-packet overlap (auto-resolves from cwd)
o8 packet diff [id]                    # this packet's code diff vs base (committed + uncommitted), byte-bounded
o8 packet commit -m "<message>"        # stage + commit the worktree with an explicit pathspec (use instead of raw git add/commit)
o8 packet heartbeat                    # lifecycle ping; safe no-op outside a packet
o8 packet report --event progress [--reason "..." --message "..."]   # surface a structured progress/blocker event
o8 packet log [id] [--follow] [--since <cursor>]                     # read or tail this packet's lane events
o8 packet runtime-drift                # detect + warn when the lane's bound runtime drifted (exit 5 on drift)
o8 packet review --approve [--commit-message "..."]                  # approve + merge a reviewed packet

# Task pool (project-backed work queue)
o8 task list [--include-done] [--include-brief] [--project <id>] [--repo <path>]   # pool grouped ready/running/review/blocked/done
o8 task create --title "..." [--summary "..." --project <id> --repo <path>]        # add a task to the ready pool
o8 task brief <id>                     # full project-backed brief for one task
o8 task claim <id>                     # bind/reserve a task to a lane
o8 task dispatch <id>                  # launch the claimed task (Codex-only routing)
o8 task block <id> --reason "..."      # mark a task blocked
o8 task report <id> --event "..."      # append a task progress event
o8 task archive <id>                   # prune/archive a stale task row
o8 task prune <id>                     # permanently remove a done/archived task row

o8 lane touches --path <file>          # other lanes touching the same file (or --packet <id>)

# Brain feedback — workers contribute observations the orchestrator promotes to directives.
# See "Contributing to the brain" below; this is the only way a worker writes to memory.
o8 cortex observe --kind <regression|pattern|gotcha|preference> --text "..." [--scope packet|repo|global]

# o8.md review surface — the operator authors o8.md; you ANNOTATE it (never overwrite).
o8 spec read     [--repo <path>]       # raw o8.md content
o8 spec index    [--repo <path>]       # structured review threads + summary
o8 spec pending  [--repo <path>]       # only the UNRESOLVED threads (what to address)
o8 spec check    [--repo <path>]       # validate the review markup
o8 spec comment  --repo <path> --body "<thought>" [--anchor "<snippet>"]   # leave a new pointer (author defaults to AI)
o8 spec reply    --repo <path> --to <id> --body "<msg>"                    # reply to a thread
o8 spec resolve  --repo <path> --id <id> [--summary "<note>"]              # mark a thread resolved
o8 spec suggest  --repo <path> --kind add|del|sub --anchor "<text>" [--text "<add>"] [--new "<replacement>"]  # propose a non-destructive edit
```

Output is JSON by default (pass `--human` for pretty ANSI). Errors come back as JSON with a stable schema + an exit code (1 invalid args, 2 connection refused, 3 unauthorized, 4 not found, 5 conflict). Calls are gated by the loopback + ws-token guard that protects the o8 API — they only work locally, no auth needed.

If a command exits 127 (`command not found`), o8.app probably hasn't run yet on this machine, or the symlink was removed; fall back to typecheck + commit and the heal-bot will pick up signals from there.

## Contributing to the brain (`o8 cortex observe`)

When you notice something the operator should remember across dispatches, emit an observation. The o8 auto-directive proposer (#746) picks observations off the queue, surfaces them as a yellow "Proposed directive" row in the O8 Activity tab, and the operator's Accept click writes them as a real directive — which then lands in every future packet's `<context>` envelope. **This is how a worker contributes to the brain.** Each kind has a specific intent:

- `--kind gotcha` — something that bit you that should bite no one again. *"Worktree dirty after `git worktree remove`; check `.git/worktrees/*` metadata before re-creating the lane."*
- `--kind pattern` — a coding rule the operator should enforce. *"Tauri webview rejects `@phosphor-icons/react`; use raw SVG path data from `@phosphor-icons/react/dist/defs/` instead."*
- `--kind regression` — a measurable degradation you found. *"`/api/panel/repos` jumped 8 → 60 ms after the projects-ledger migration."*
- `--kind preference` — a stylistic / workflow choice the operator stated. *"This operator prefers `paddingTop/paddingLeft` longhand to `padding: '12px 14px'` shorthand (React 19 warns on the mix)."*

`--scope packet` (default) means "this is specific to this packet's domain"; `--scope repo` is "all packets in this repo should remember this"; `--scope global` is "every dispatch across every repo should remember this." When in doubt, use `repo`.

The CLI auto-detects your packet from the worktree path — no need to pass `--packet-id` from inside `.cortex-worktrees/packet-*`. If the orchestrator dispatched you to a non-packet path, pass `--packet-id` explicitly.

**Use this whenever:** post-completion you'd write a "by the way" note to the operator. The proposer will surface it. The operator will Accept or Dismiss. Either way, the brain learns and the next agent doesn't have to rediscover what you found.
