# Tauri Deployment Guide — o8

> **Status:** Historical packaging snapshot from 2026-03-23. Ports, process
> supervision, panel geometry, signing, and bundled resources have changed.
> Use `AGENTS.md`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, and
> `scripts/tauri-export.mjs` as current authority; the remaining issue list is
> retained as history until this guide is rewritten.
> **Last updated:** 2026-03-23
> **Author:** Mister (agent session, handoff for next agent)

## Architecture

o8 is a **Next.js 16** app that runs inside a **Tauri v2** native shell on macOS.

```
┌─────────────────────────────────────────────────┐
│ Tauri Shell (.app / .dmg)                       │
│  ├── WebView → loads the selected local API port│
│  ├── Spawns: node server.js (Next.js standalone)│
│  ├── Spawns: node ws-server.mjs (WebSocket)     │
│  └── Resources: server/ + bin/o8                │
└─────────────────────────────────────────────────┘
```

### Key files

| File | Purpose |
|---|---|
| `src-tauri/src/lib.rs` | Tauri setup — spawns Node server + WS server on launch |
| `src-tauri/tauri.conf.json` | Build config — `frontendDist: "../out/frontend"`, resources: `"../out/server": "server/"` |
| `scripts/tauri-export.mjs` | Prebuild — splits build into `out/frontend/` (loader HTML) + `out/server/` (standalone) |
| `scripts/bundle-node.mjs` | **DISABLED** — Node.js is now a prerequisite, not bundled |
| `out/frontend/index.html` | Loader that probes the packaged API port block until the server starts, then redirects |
| `out/server/` | Next.js standalone server + node_modules + ws-server.mjs + bin/o8 |

### Build flow

```bash
npm run build                    # Next.js standalone build
node scripts/tauri-export.mjs    # Split into frontend/ + server/
# (Node.js NOT bundled — user must have it installed)
cargo tauri build --target x86_64-apple-darwin   # or aarch64-apple-darwin
```

The `tauri:prebuild` script in `package.json` runs `next build && node scripts/tauri-export.mjs`.

## Panel Naming (CURRENT)

Every agent must use these names consistently:

| Panel | Code Name | Location | Description |
|---|---|---|---|
| **AgentPanel** | `src/components/desktop/AgentPanel.tsx` | Left column | Repo-grouped agents, projects, and repository activity |
| **WorkspaceTerminal** | `src/components/desktop/WorkspaceTerminal.tsx` | Center tile | Orchestrator, runtime chat, terminal, and canvas tabs |
| **O8Panel** | `src/components/desktop/O8Panel.tsx` | Right column | Workspace, browser, PR, activity, inbox, spec, and utility views |
| **Header strips** | `src/components/desktop/shell/*HeaderStrip.tsx` | Column headers | Window drag regions, workspace tabs, and column controls |
| **DesktopStatusBar** | `src/components/desktop/DesktopStatusBar.tsx` | Bottom bar | Settings, pairing, ports, alerts, branch, and terminal controls |

### Tile system

- Tiles are defined in `src/lib/tiles/types.ts` — `TileContentKind`
- Tile layout persisted in localStorage key `cortex-ide:dashboard-tiles:v2`
- WorkspaceTerminal (`terminal` kind) is **unclosable** — the last one is always protected
- ContextualPanel (`contextual-panel` kind) is closable and toggleable
- Canvas tabs (files, issues, diffs) render INSIDE ContextualPanel, not as a separate tile
- Legacy `canvas` and `bottom-terminal` tile kinds are migrated to `contextual-panel` on load
- Splitting WorkspaceTerminal creates a new `terminal` tile; splitting ContextualPanel creates a new `contextual-panel` tile

## What Works in Tauri (Tested 2026-03-23)

- ✅ .app builds (253-318MB depending on bundled modules)
- ✅ .dmg builds
- ✅ Next.js standalone server starts from bundled `server.js` (boots in ~130ms)
- ✅ WS server starts from bundled `ws-server.mjs`
- ✅ Dashboard loads with data (3 agents, 13 sessions, 15 issues)
- ✅ API Keys page loads (Google AI key detected from `~/.cortex-ide/.env.local`)
- ✅ GitHub App authentication (App ID: 3167857, Installation: 118508031) — 5,450 req/hr
- ✅ GitHub API cached for 5 minutes (90% reduction in API calls)
- ✅ Cortex binary bundled at `server/bin/cortex` (24MB Go binary)
- ✅ `better-sqlite3` native module with Turbopack hash symlink
- ✅ `node-pty` native module for terminal support

## Known Tauri-Specific Issues

### 1. Native module Turbopack hash mismatch
**Root cause:** Turbopack renames native modules with hash suffixes (e.g., `better-sqlite3-90e2652d1716b047`). The bundled `node_modules/better-sqlite3` doesn't match.

**Current fix:** `tauri-export.mjs` scans server chunks for hashed names and creates symlinks. Works but fragile.

**Better fix:** Use `serverExternalPackages` in `next.config.ts` (already set for `better-sqlite3`). May need to add more native modules as they're discovered.

### 2. Node.js version must match native modules
Native modules (`.node` files) are compiled for a specific Node.js ABI version. The bundled server's `node_modules` were compiled by the developer's system Node. If a user's Node version has a different `NODE_MODULE_VERSION`, native modules will fail to load.

**Current approach:** Node is a prerequisite (not bundled). User's own Node runs the server.

**Risk:** User's Node version might not match the compiled native modules. May need to add `npm rebuild` to the first-launch flow.

### 3. `.env.local` not in bundle
The standalone server runs from inside `o8.app/Contents/Resources/server/`. It doesn't have the project's `.env.local`.

**Current fix:** Keys route reads from `~/.o8/.env.local`. The Settings → API Keys UI writes to this location.

**For users:** They set keys through the Settings UI, which writes to `~/.o8/.env.local`.

### 4. Zombie server processes
When Tauri closes, the spawned `node server.js` and `node ws-server.mjs` processes may not be killed. They continue running at 100% CPU (especially if they hit error loops).

**Fix needed:** Tauri `on_window_event(CloseRequested)` should kill child PIDs. Currently it just hides the window.

### 5. DMG signing
DMG builds work but aren't code-signed. macOS shows "unidentified developer" warning. Needs Apple Developer account ($99/yr) for signing + notarization.

### 6. `process.cwd()` is wrong in bundled app
Several API routes use `process.cwd()` as the default workspace root. In the Tauri bundle, `cwd` points to the `.app` Resources directory, not a user project.

**Fix needed:** Routes should use the user's selected repo path (from the repo selector) instead of `cwd()`.

## Config Locations

| Path | Purpose |
|---|---|
| `~/.o8/.env.local` | Optional encrypted/local provider keys |
| `~/.o8/github-app.pem` | GitHub App private key (when configured) |
| `~/.o8/cortex-ide.db` | SQLite database |
| `~/.o8/setup.json` | Setup wizard state |
| `~/.o8/chat-history/` | Persisted chat history |
| `~/Library/Logs/ai.o8.desktop/o8.log` | Tauri app log |

## GitHub Integration

- **GitHub App:** "cortex-dev-agent" (App ID: 3167857)
- **Broker auth:** `src/lib/github-broker/auth.ts` resolves managed or BYO
  GitHub App installation tokens.
- **BYO token source:** `src/lib/github-app.ts` generates the app JWT and
  exchanges it for an installation token.
- **Broker state/cache:** `src/lib/github-broker/` owns synchronized
  installation/repository state; `src/lib/github/cache.ts` remains the small
  process-local cache used by legacy reads.
- **CLI-backed tools:** `src/lib/github/tools.ts` invokes `gh` with argument
  arrays and relies on the active `gh auth` identity.

Broker rollout note:

- Broker-backed setup and environment requirements are documented in
  [GITHUB-BROKER-SETUP.md](./GITHUB-BROKER-SETUP.md).
- Production webhook sync still requires the final public URL before the GitHub App webhook can be completed

## Repo Selector

- Starts empty — no auto-loaded repos
- "Open Folder" button in top header opens Finder dialog (needs `onOpenFolder` wired to Tauri `dialog.open`)
- User selects a repo, it becomes the active workspace
- `REPO_DISPLAY` is empty — no hardcoded repo names

## What an Agent Needs to Do for Final Tauri Ship

1. **Wire `onOpenFolder` to Tauri dialog API** — `@tauri-apps/plugin-dialog` → `open({ directory: true })` → set as active workspace
2. **Kill child processes on app close** — in `lib.rs`, track server/WS PIDs and kill on `CloseRequested`
3. **Test native module compat** — ensure `better-sqlite3` and `node-pty` work with the user's installed Node version
4. **First-launch experience** — if Node.js not found, show install instructions in the loader HTML (partially done)
5. **Test on Apple Silicon** — current builds are x86_64 only, need `aarch64-apple-darwin` target too
6. **Rebuild and full QA** — `cargo tauri build`, launch .app, test all panels, verify no layout corruption

## Commits from 2026-03-23 Session

```
2c6430c fix: Split terminals are closable — only the LAST one is protected
7952eb9 fix: Bump tile layout version to force reset broken layouts
764f4a9 fix: WorkspaceTerminal is now unclosable — prevents layout corruption
44f983c fix: Empty repo selector + safe ContextualPanel toggle
8be8073 fix: Monaco editor fills ContextualPanel + suppress clipboard cancel errors
9cf241c fix: ContextualPanel tab switching preserves state + smart splits
d655dab feat: Unified ContextualPanel — canvas tabs merged into bottom panel
0da0bc7 refactor: Canonical naming for all panels
a22ec01 feat: Drop bundled Node (prerequisite) + bundle Cortex memory binary
3dbbdb8 fix: Cortex-facts parallel queries + Node 25 for native module compat
5827b8f fix: Graceful degradation for better-sqlite3 in production bundle
5bb7f32 feat: WS server bundled in Tauri app
b7afcab fix: Standalone app — better-sqlite3 Turbopack hash symlink
c5085de feat: Bundle Node.js inside the app
2d9c123 fix: Split frontend/server for Tauri build
a9233f8 feat: Standalone server bundling for Tauri
9f199e2 fix: Remove all hardcoded personal data
1111c6e feat: GitHub PAT support + config lives in ~/.cortex-ide/
36cade2 feat: GitHub App authentication
19a0500 fix: GitHub API — 5min cache TTL + token injection
41f1f02 feat: Inline edit — prompt history + accept/reject diff preview
0d8a736 feat: Inline AI widget — frosted glass card at cursor line
658912f feat: Environments filter in files dropdown
```
