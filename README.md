# o8

**The governance layer for autonomous engineering teams.** A Rainwater product.

> **Rainwater** is the company. It builds two things:
> - **o8** — the IDE / control plane. Where AI agents do engineering work under human oversight.
> - **Symon** — the voice agent. The operator's chief-of-staff: it directs o8 by voice and lives across your Mac.
>
> Company : products :: Anthropic : Claude.

o8 is a **Next.js 16 + Tauri v2 desktop app** (with a mobile remote-control surface). It is *not* a code editor — it's the **control plane** for autonomous engineering: approvals, audit, organizational memory, and operator control across any AI provider.

**Shipping runtime pattern (v1):** Claude Code orchestrates, Codex works. A Claude Code REPL (subscription-billed) is the orchestrator; Codex GPT-5.5 xhigh is the worker, running in isolated git worktrees. Gemini and opencode adapters are wired for future expansion. All four route through one universal CLI adapter interface (`src/lib/runtimes/`), with separate desktop and mobile surfaces.

The moat is **governance, organizational memory, and the operator approval surface** — not the things models will commoditize (cost dashboards, prompt tools, orchestration quality).

---

## What's real today vs. what's coming

This README is honest about state. Everything under **Real** ships in the current release and is verified; everything under **Coming** is designed/in-progress.

### ✅ Real / shipped
- **Runtime adapter system** — Codex, Claude Code, Gemini, opencode behind one `AgentRuntime` interface; capability-gated discovery, parallel session discovery, unified dispatch.
- **Mission dispatch + governance** — `create_mission` → `dispatch_mission` → review the diff → `approve_and_merge`. Every worker runs in an isolated worktree; nothing merges without an operator review. A 5-layer merge-failure escalation chain.
- **Cortex v2 organizational memory** — operator directives + a session-outcome ledger (SQLite), auto-directive proposals, and the **Engineering Brain** Q&A surface ("what did Codex do today?", "how does dispatch work?").
- **The MCP surface** — two stdio servers (operator + cortex) exposing o8 to Claude, plus 12 `o8_view_*` webview-control tools that let an external Claude drive the running app.
- **The `o8` CLI** — agents inside packet worktrees get `packet info/scope/heartbeat/report`, `lane touches`, `cortex observe`, `o8 run`, `o8 spec …`, `o8 doctor`.
- **Symon, the voice agent** — native macOS tools (Reminders, Calendar, Notes, Mail, Contacts, Shortcuts, open-app, filesystem) **plus** a Tier-2/3 bridge into o8 itself (read fleet state, ask the Brain, delegate coding work) — every mutation behind a spoken confirm card. Push-to-talk via Left-Option; the morphing notch dock; a "Synthesizing…" + timer card with the o8 orbit motion while it works.
- **Mobile remote-control surface** — `src/components/mobile/`, paired to the local backend, for kicking off and reviewing work away from the keyboard.
- **Two-axis theming** (palette × surface), the dock, the review surface, the right-side O8Panel.

### 🚧 Coming / in design
- **Symon's "beat-Siri" tool set** — `apple_music_play`, `spotify_control`, `read_screen`, `app_intent` (control any scriptable Mac app). Roadmap: `~/o8-symon-tools-roadmap.md`.
- **Real-time speech-to-speech** for Symon (currently push-to-talk + cascaded). gpt-realtime-2 / Gemini Live under evaluation.
- **A reasoning-grade brain for Symon** — today Symon's loop is **100% Gemini Flash direct** (it nails tool-selection); a Claude-REPL-subscription path for heavy reasoning is designed, not yet wired.

---

## The pieces

### o8 — the IDE / control plane
Desktop layout: a resizable AgentPanel (left), a TileContainer of workspace terminals (center), and a 440px O8Panel (right) with Pulse / Browser / PRs / Inbox / Activity / o8.md tabs. The **Orchestrator** is a tab inside the workspace, not a floating tile. A WebSocket server (port 3002) multiplexes real-time data to mobile. SQLite (better-sqlite3 + Drizzle) in `~/.o8/`. Full architecture in [`CLAUDE.md`](./CLAUDE.md) and [`docs/`](./docs/).

### Symon — the voice agent
Symon is the **life-layer**: voice-first, tool-heavy, and ingrained in your whole Mac — not just code. The boundary with the orchestrator is one rule:

> **If the action mutates a git repo → it routes to the orchestrator (the coder). Everything else → Symon does directly.**

So *"remind me to call Q at 3"* → Symon does it; *"what's shipping?"* → Symon reads o8 state aloud; *"have the orchestrator fix the auth bug in cortex-ide"* → Symon delegates a **gated** mission (it speaks the repo back + shows a confirm card before any worker spawns). Symon talks to o8 as a third client of o8's own loopback API — no orchestration logic is duplicated. Code lives in `src-tauri/src/agent/`.

### The MCP servers (`src/lib/mcp/`)
- **`operator-mcp-server.ts`** — the operator's interface: `o8_status`, `o8_send`, `create_mission`, `dispatch_mission`, `get_mission_status`, `submit_review`, `approve_and_merge`, `cortex_ask`, the `o8_view_*` webview-control tools, and the `o8_spec_*` o8.md review tools.
- **`cortex-mcp-server.ts`** — internal tools spawned by orchestrator sessions (fleet / issues / PRs / approvals).

Install from **Settings → MCP** (writes Claude Desktop / Claude Code config with merge-preserving backups).

### The `o8` CLI
Symlinked to `/usr/local/bin/o8` after first launch. Dispatched agents use it inside worktrees; operators use it directly. See [`AGENTS.md`](./AGENTS.md) for the full command list (`packet *`, `lane touches`, `cortex observe`, `run`, `spec *`, `doctor`).

### The mobile app
A remote-control surface (`src/components/mobile/`) — a separate codebase from desktop by design, paired to the local backend. Approve, dispatch, and watch the fleet from your phone.

---

## How Symon was acquired

Symon's voice stack was **acquired as `aqua-color`** — a macOS voice app built around a notch-dock HUD: push-to-talk dictation, on-device polish, TTS, a global Fn hotkey, and paste-into-the-frontmost-app. Rainwater folded that stack into o8 as **Symon**, the agent:

- The dictation engine, the morphing **notch dock**, the polish/TTS pipeline, and the global hotkey were ported wholesale (`src-tauri/src/{fn_hotkey,paste}.rs`, the dock window, the STT engine).
- The tool-calling loop (`agent/{gemini,openrouter}.rs`) was lifted and **de-coupled** from the standalone app — re-pointed to o8's `~/.o8` data dir, the license proxy dropped, errors simplified.
- Then it was **extended past anything the original app did**: the o8 control-plane bridge (read fleet state, ask the Engineering Brain, delegate gated coding work) and the SafetyClass confirm gate.

The parity audit (`docs/symon-parity-checklist.md`) tracked "o8 does everything aqua-color did"; the system-wide fold spec is `docs/symon-systemwide-fold.md`.

---

## Voice + control planes, together

This is the thesis Rainwater is building toward: **the orchestrator replaces you in the codebase; Symon replaces you everywhere else — and is the one who talks to the orchestrator on your behalf.**

- The orchestrator is the **specialist coder** — it dispatches Codex in worktrees, reviews diffs, and ships behind your approval.
- Symon is the **voice operator** — it knows your context (it hears your dictation, will see your screen), answers about the fleet, runs your non-coding life, and *directs* the coder by voice.
- The seam between them is **governed**: every mutation — a dispatch, a reminder, a file write — passes a spoken confirm card. That governance is the moat new-Siri doesn't have.

---

## Quickstart

Prerequisites: **Node.js 22+** (ABI-pinned for `better-sqlite3`), **Rust stable**, **Xcode CLT** (macOS) / build-essential (Linux). Optional: **Codex CLI** (mission dispatch), **`gh` CLI** (`create_mission` from issues).

```bash
git clone https://github.com/hurttlocker/cortex-ide.git
cd cortex-ide
cp .env.example .env.local      # optional API keys
npm install
npm run desktop:dev             # Next.js :3001 + WS server :3002
```

Open `http://localhost:3001/dashboard`, or run `cargo tauri dev` from `src-tauri/` for the native shell.

### Native build & ship

```bash
npm run build                   # Next.js prod build + bundled server export
cargo tauri build               # native installer (dmg/msi/deb)
# release loop (signed + auto-update):
npm version patch && git push --follow-tags && npm run ship
```

If you fork and ship your own releases, replace `plugins.updater.endpoints` + `pubkey` in `src-tauri/tauri.conf.json` with your own channel and minisign key.

### Connect Claude to o8
1. **Settings → MCP** in the desktop app.
2. **Install** next to "Claude Desktop" (or "Claude Code").
3. Restart Claude Desktop (or `/mcp reload` in Claude Code).
4. Claude now has o8's tools: `o8_status`, `create_mission`, `dispatch_mission`, `approve_and_merge`, `cortex_ask`, the `o8_view_*` controls, and more.

See [`.env.example`](./.env.example) for the full environment-variable reference and which feature each unlocks.

---

## More

- [`CLAUDE.md`](./CLAUDE.md) — architecture, conventions, critical rules (also the canonical agent brief).
- [`AGENTS.md`](./AGENTS.md) — the `o8` CLI reference.
- [`DESIGN.md`](./DESIGN.md) / [`hurttlocker.md`](./hurttlocker.md) — design language + locked typography/icon/layout spec.
- [`docs/`](./docs/) — product brief, company thesis, runtime adapter contract, vocabulary glossary.

_Private working repository. © Rainwater._
