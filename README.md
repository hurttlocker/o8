# o8

Private working repository for **o8**, an AI-native desktop app product.

## Quickstart

Prerequisites:
- **Node.js 22+** — `node --version` (install from [nodejs.org](https://nodejs.org))
- **Rust stable** — for the Tauri build (`rustup install stable`)
- **Xcode Command Line Tools** (macOS) or **build-essential + python3** (Linux) — needed by `better-sqlite3` / `node-pty` during `npm install`
- **Codex CLI** (optional, required for mission dispatch) — `npm i -g @openai/codex-cli`
- **`gh` CLI** (optional, required for `create_mission` from GitHub issues)

Clone and run:

```bash
git clone https://github.com/hurttlocker/cortex-ide.git
cd cortex-ide
cp .env.example .env.local   # fill in optional API keys
npm install
npm run desktop:dev          # starts Next.js on 3001 + WS server on 3002
```

Open `http://localhost:3001/dashboard` in a browser, or run `cargo tauri dev` from `src-tauri/` for the native shell.

### Native build

```bash
npm run build                # Next.js production build + bundled server export
cargo tauri build            # native installer (dmg/msi/deb)
```

If you're forking and plan to ship your own releases, replace the `plugins.updater.endpoints` and `pubkey` in `src-tauri/tauri.conf.json` with your own release channel and minisign public key. Otherwise the packaged app will check for updates against the upstream o8 release feed.

### Connect Claude to o8

1. Open the desktop app and go to **Settings → MCP**.
2. Click **Install** next to "Claude Desktop" (or "Claude Code").
3. Restart Claude Desktop (or run `/mcp reload` in Claude Code).
4. Claude now has access to o8 tools: `o8_status`, `o8_send`, `create_mission`, `dispatch_mission`, `approve_and_merge`, etc.

See `.env.example` for the complete list of environment variables and which features each one unlocks.

## What this is

o8 is a thesis for an **agent-native development environment**:

- the unit of work is not just a file, but an **agent**
- the product is not just an editor, but an **agent command center**
- memory is not an afterthought, but a first-class **operating system primitive**
- mobile is not a bolt-on viewer, but a **remote control surface** for approval, monitoring, and steering

This repo captures the initial company thesis, v0 product spec, system architecture, mobile strategy, research notes, and the first live shell prototype.

## Current position

### Core belief
The next big developer product may not be another autocomplete-heavy editor.
It may be the best place to **run, supervise, steer, and scale teams of coding agents**.

### Initial wedge
Start as a **multi-agent control plane** that works across existing runtimes.
Do **not** begin as a full VS Code fork.

### Working product framing
- **Cortex** = memory and continuity substrate
- **OpenClaw / ACP runtimes** = execution substrate
- **Git / GitHub / worktrees / terminals** = software delivery substrate
- **Autonomous Tools** = native file, terminal, and github integration
- **o8** = operator surface that makes all of it legible and steerable

### Front-door rule
The product should feel like a **beautiful, fluent AI chat surface on first contact**, then progressively reveal deeper review, runtime, and org-control layers.

That means:
- protect the chat page as the onboarding/front-door surface
- let deeper control open contextually from within the same product language
- do not let runtime/operator depth bulldoze the familiar chat experience

### Mobile view
Mobile support should likely exist from day one, but as a **remote operator surface**, not a full mobile IDE.
The right model is:

- desktop does the heavy lifting
- phone handles approvals, status, notifications, quick steering, Cortex recall, and diff review

## Repo map

- `docs/company-thesis.md` — why this company should exist
- `docs/chat-front-door-doctrine.md` — product memo + implementation doctrine for preserving chat as the front door while layering runtime depth underneath
- `docs/v0-product-spec.md` — first shipping surface and user flows
- `docs/v1-build-plan.md` — v1 plan grounded in Karpathy’s command-center requirements
- `docs/system-architecture.md` — system map and where Cortex / OpenClaw / Paperclip fit
- `docs/mobile-strategy.md` — day-one mobile thesis and architecture
- `docs/roadmap.md` — phased build sequence
- `docs/issue-map.md` — epic lanes and issue structure
- `docs/remodex-integration-plan.md` — how to use the Remodex/Phodex lane without letting it define the whole product
- `docs/research/x-thread-notes.md` — notes from the Karpathy + Remodex threads
- `docs/fleet-state-model.md` — first state taxonomy for agents and squads
- `docs/runtime-adapter-contract.md` — first runtime abstraction contract
- `docs/desktop-app-strategy.md` — Option B + touch of A desktop packaging path
- `docs/live-openclaw-bridge.md` — why the first live mode mirrors this session instead of auto-spawning a new one
- `assets/mockups/` — early visual directions
- `src/app/` — initial Next.js desktop + mobile remote shell prototype
- `electron/` — native desktop shell wrapper for the control plane

## Initial product stance

### What it is not
- not just a prettier tmux grid
- not just another chat pane inside VS Code
- not just a memory plugin
- not just Paperclip renamed

### What it could become
- the **Cursor for agent organizations**
- the **control tower for 5–50 agents**
- the place where memory, execution, review, and approvals become one system

## Near-term recommendation

1. Prove the wedge as a **standalone command center** first
2. Add desktop + mobile operator surfaces
3. Integrate Cortex deeply as the memory and audit substrate
4. Consider VS Code distribution later only if the control plane is already clearly valuable

## Local preview

Optional `.env.local` values:
- `GEMINI_API_KEY` — enables Gemini-backed features
- `GITHUB_OAUTH_CLIENT_ID` — enables in-app GitHub device login in Settings
- `GITHUB_OAUTH_SCOPES` — optional override for requested GitHub OAuth scopes
- `WS_TOKEN` — required for authenticated worktree/WebSocket routes when used

```bash
cd cortex-ide
npm install
npm run dev
```

Routes:
- Desktop shell: `http://localhost:3001/`
- Mobile remote preview: `http://localhost:3001/mobile`
- Live OpenClaw fleet JSON: `http://localhost:3001/api/openclaw/fleet`

## Native desktop shell (current dev path)

```bash
cd cortex-ide
npm install
npm run desktop:dev
```

This keeps the current control-plane architecture intact while giving the product a real desktop-app shell early.

## Status

Drafted on 2026-03-11.
Execution started on 2026-03-11 with a real desktop shell, mobile remote preview, fleet state model, runtime adapter contract, and an Electron desktop wrapper for the control plane.
Private repo only for now.
