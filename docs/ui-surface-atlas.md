# o8 UI Surface Atlas — what the human can actually see

**Status:** research pass · 2026-06-11 · source-of-truth inventory for the UI/Canvas session.
**The test:** a surface is REAL only if the operator can reach it with real clicks/keys on the installed production app (`/Applications/o8.app`). Code that renders nothing a human can reach is listed in "Present but not real" — it must not anchor design decisions.

Sister docs: [`canvas-mode-vision.md`](./canvas-mode-vision.md) (where this UI is heading), [`../hurttlocker.md`](../hurttlocker.md) (operator-locked geometry — read before touching ANY surface), [`../DESIGN.md`](../DESIGN.md) (palette/motifs).

### A. Main window chrome

- **Column header strips** (`src/components/desktop/shell/LeftHeaderStrip.tsx`,
  `WorkspaceHeaderStrip.tsx`, `PanelHeaderStrip.tsx`) — drag regions, traffic
  lights, workspace tabs, and column controls. They replaced the retired
  monolithic TitleBar/NavRail chrome and are always visible for mounted columns.
- **SessionTimeline** — 36px strip under the column header, **OFF by default** since epic #1089; also hidden under 420px width. Most users never see it: treat as opt-in, not core chrome.
- **DesktopStatusBar** (`src/components/desktop/DesktopStatusBar.tsx`) — the bottom dock: Settings gear, mobile-pairing button, Add-repo (Iconoir FolderPlus), Ports cluster (web ports popover, Iconoir Internet rows), supervisor-inbox badge (Iconoir Mail/MailOpen), branch-picker pill, global-terminal toggle, merge cluster. This bar is the app's persistent control strip — densest icon surface in the app, all geometry hurttlocker-locked.

### B. Left panel

- **AgentPanel** (`src/components/desktop/AgentPanel.tsx`) — resizable left column: repo-grouped agent/chat rows, status groups, issues/PRs/CI/deploys. Text-first rows (leading icons stripped 2026-05-25, per hurttlocker "Iconography rule"). The three locked alignment columns live here: icon x≈12, section labels x=29, text x=37, right-edge icons x=235 (optically corrected).
- **LeftPanelProjectFocus** (`src/components/desktop/repo-focus/LeftPanelProjectFocus.tsx`) — the "control room" drawer that replaces the panel content. Verified 2026-06-11: clicking a project/repo row only SELECTS it (`handleMiniProjectSelect` / `handleMiniRepoSelect`); the drawer opens from the row's hover-revealed chevron (`handleMiniOpenControlRoom`). Tabs: **Agents** (live + archived packets — where PacketCards live day-to-day), Context, Spec, Files.
- **AddRepoDialog** — from the status-bar Add-repo affordance.

### C. Center workspace — tiles + tab kinds

**TileContainer** (binary-tree tile layout, `src/lib/tiles/`) hosts **WorkspaceTerminal** tiles; each tile owns its own column strip (tab pills via `WorkspaceHeaderStrip.HeaderPill` — divs, not TabBar.tsx). `TILE_LAYOUT_VERSION = 4`.

Tab kinds a human can actually create (`workspace-terminal/types.ts`):
- **`orchestrator`** — THE primary surface. `OrchestratorTab.tsx`: ThoughtsChatPanel + OrchestratorEmptyState (centered "What should we build in <repo>?" hero + composer + context chips; the old 6 quick-action cards now live in the ⌘K QuickActionPalette) + SessionVisualizer strip when agents run. Inline TurnSummaryCard / ChatActionCard / tool-chip clusters (incl. the Brain chip). ⚠️ Verified 2026-06-11: OrchestratorTab and dashboard/page.tsx BOTH bind window-level ⌘K — two palettes open stacked (see polish list).
- **`terminal`** — always available.
- **`chat`** — single-runtime CLI session (Codex by default); only offered when the runtime binary is detected. ⚠️ Naming gotcha: this is NOT the casual chat.
- **`llm-chat`** — the casual Assistant chat. **GATED OFF by default** (`experimentalChat=false`): a fresh user NEVER sees it. Don't design around it as if it's core.
- **`canvas`** — exists as a kind but is **agent-created only**; no human affordance creates one today. Relevant: the name is free real estate for Canvas mode.

### D. Right panel — O8Panel

`src/components/desktop/O8Panel.tsx`, default width 440px (max default 480), localStorage-persisted. **The REAL tab union** (`o8-panel/types.ts`) — note CLAUDE.md's "7 tabs (Pulse/…/o8.md)" listing has drifted; trust this:
- Main: **workspace · browser · prs · activity · inbox · spec · launcher**
- Utility (right-rail, launcher-managed): **files · side-chat · browser · review · terminal**
- **review** mode hosts ReviewPanel (epic #1085, Codex-style single diff) + **O8ScratchChat** ("Ask the Brain", CircleSpark icon — same icon intentionally reused on spec/o8.md surface to unify the "ask o8" affordance).
- **spec** = the o8.md review surface (CriticMarkup threads).

### E. Settings

The status-bar gear opens an account mini-menu (profile · Settings · Usage remaining) — "Settings" in it opens the full-screen overlay. Rams-language components (`settings/shared.tsx`: RamsButton, CornerBrackets, SectionLabel, BracketLabel source badges). Sidebar verified 2026-06-11, grouped: CONNECTIONS (Connectors, API Keys, MCP, Mobile) · WORK (Dispatch — the operator-defaults surface, Projects, Workers `(soon)`, Cloud Workers `(soon)`) · PRESENTATION (**Appearance** — palette cards labeled light/"dark" + session-timeline + reduce-transparency, **Voice**) · SYSTEM (Plan & Billing, …below fold). Note: Appearance's second palette is LABELED "dark" while code/docs call it midnight.

### F. Overlays, modals, popovers, toasts

Human-reachable: **CommandPalette** (⌘K) · **KeyboardShortcutsOverlay** (⌘/) · **ApprovalBanner** + approval cards · mission-complete modal · **UpdateCard** (auto-update) · **Onboarding/FTUX** (6 steps: welcome carousel → repos → runtimes → dispatch runtime → import → ready) · **DictationHost** pill (push-to-talk, Ctrl+Z hold; mic button beside Send) · PacketDetailsPopover + packet-row inline editors (Issues-style rows, custom popovers — native `<select>`/`<input>` banned in packet cards) · branch-picker popover · alert toasts / chat toast stack · repo-registry + diagnostics-reset modals · confirmation strips (the "no overflow menus" pattern).

### G. Secondary windows (separate Tauri windows)

- **Symon dock** (`src/app/dictation-pill/`) — top-center always-on-top nonactivating sliver; white-glass closed state; modes: answer panel, confirm card (agent governance surface), capsule, Synthesizing card with o8-orbit motion, voice-settings glass modal, speaking-speed slider, Revert chip (text-edit governance). Trigger: Right-Option agent, double-tap Right-Option long form, Ctrl+Shift+S say, Fn dictation. **Symon is a full o8 user** — it calls `o8_ask` and names its sources in speech.
- This is the closest existing thing to the "Siri feel" — the Canvas session should study its glass + motion language first.

### H. Mobile (separate codebase — brief)

`src/components/mobile/` — remote-control surface (approvals, inbox, orchestrator threads), QR/`#tk=` pairing, Expo native rebuild tracked separately (#1074). **No shared components with desktop by design.** Canvas mode must NOT assume mobile parity — mobile degrades to lists.

### I. Present in code but NOT human-visible

Do not design around these; do not resurrect without operator sign-off:
- **Retired (dead, some files linger):** NavRail, ThoughtsMissionPanel, WorkspaceSidePanel, OrchestratorChatTile/MissionControlTile/OrchestratorHistoryTile + tile kinds `thoughts`/`mission-control`/`orchestrator-history` (migrated away at TILE_LAYOUT_VERSION 4), AgentPanelChat, ConnectionBanner, ApprovalQueuePanel.
- **Flag-gated OFF by default:** `llm-chat` tab (experimentalChat), Gemini + opencode in pickers (experimentalGemini/experimentalOpencode), SessionTimeline (off-default).
- **Conditional:** `chat` kind without a detected runtime; DesignModeOverlay (env-gated debug); canvas tabs (agent-created only).
- **Lane events** (`brain_consulted` etc.) — recorded + WS-broadcast but have NO packet-card renderer yet; a known gap, not a surface.

### J. Deliberate "imperfections" — DO NOT FIX

These look like bugs to fresh eyes; they are operator-locked decisions (hurttlocker.md is canonical):
- **Optical centering beats mathematical centering.** Chevrons/FilterList sit at x=235 not x=233 because their visible glyph centers sit left of their SVG bounding box — "don't trust the math, measure the rendered pixel" (hurttlocker §96). 1–2px "off-center" icons are usually centered *to the human eye*. Never "fix" alignment without screenshotting the rendered pixels first.
- **Font-weight 260–350 on meta lines**, system stack over webfonts, weight bumps above spec when density makes 400 read thin — eye ergonomics over Figma fidelity.
- **Two icon libraries on purpose** (Lucide default + Tabler/Iconoir overrides where glyph design wins at-size); raw-SVG shims because the Tauri webview can't render the React icon components. No migration to one library is planned.
- **Glass tints are load-bearing:** low-opacity rgba whites ARE the glass; never blanket-replace with solid tokens. The center workspace (chat/canvas/terminal paper) is ALWAYS solid — only chrome is glass.
- **Text-first rows** — leading icons deliberately stripped from list rows; the three text/icon columns are locked geometry.
