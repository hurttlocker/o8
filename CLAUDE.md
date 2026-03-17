# Cortex IDE — Claude Code Dossier

> You are working on **Cortex IDE** — a Next.js + Tauri desktop app that serves as a command center for managing AI agent fleets. Think: "CEO dashboard for AI engineering teams."

## Vision (One Sentence)
"Cortex IDE should feel like being a CEO who can run their entire engineering team from the back of an Uber."

## Design Philosophy
**Steve Jobs lens.** Every pixel matters. Density with restraint. Progressive disclosure. If Apple wouldn't ship it, neither do we.

**Karpathy lens (Software 3.0).** This is a control plane, not an editor. Intent over instruction. Observable agents. Human oversight as a feature, not a bottleneck.

**No emojis anywhere** — Lucide icons only across all surfaces.

## Tech Stack
- **Next.js 16** + **React 19** + **TypeScript**
- **Tauri v2** for native desktop shell (macOS)
- **Inline styles everywhere** — CSS classes are unreliable on iOS Safari, so the entire project uses inline `style` props. This is intentional and permanent.
- **framer-motion** for animations (spring curves: `stiffness: 400, damping: 30`)
- Dev server: `npm run dev` → `http://localhost:3001`
- Tauri dev: `cd src-tauri && cargo tauri dev`

## Architecture

### Layout (Desktop Dashboard — `src/app/dashboard/page.tsx`)
```
┌─────────────────────────────────────────────────┐
│ TitleBar (44px, drag region, traffic lights)     │
├─────────────────────────────────────────────────┤
│ SessionTimeline (36px, day-level activity)        │
├──────┬──────────────────────┬───────────────────┤
│ Nav  │    AgentPanel (left)  │  Center Workspace │ Chat │
│ Rail │    or IntentCanvas    │  (Canvas/Settings) │      │
│ 56px │    or SettingsPage    │                    │      │
└──────┴──────────────────────┴───────────────────┘
```

### Key Files (read these first)
| File | Lines | What it does |
|------|-------|-------------|
| `src/app/dashboard/page.tsx` | ~592 | Main layout orchestrator. All panels toggled here. |
| `src/components/desktop/AgentPanel.tsx` | ~1916 | **THE BIG ONE.** Agent fleet view, repo-grouped cards, status groups (In Progress/Idle/Done), activity feed, issues, PRs, files, CI, deploys. |
| `src/components/desktop/DesktopChat.tsx` | ~1948 | Chat panel with message rendering, send, markdown. |
| `src/components/desktop/Canvas.tsx` | ~2760 | Bottom workspace: issue viewer, transcript viewer, file viewer, timeline. |
| `src/components/desktop/ThoughtsCard.tsx` | ~1525 | Floating glass overlay — mini chat with agents, approvals, agent picker. z-index 9999. |
| `src/components/desktop/NavRail.tsx` | ~354 | Left sidebar nav, framer-motion collapse/expand. |
| `src/components/desktop/TitleBar.tsx` | ~390 | macOS-style title bar with inline SVG icons (Lucide doesn't render in Tauri). |
| `src/components/desktop/SessionTimeline.tsx` | ~457 | Day-level timeline showing coding/thinking/testing/idle segments. |
| `src/components/desktop/IntentCanvas.tsx` | ~379 | Fleet Command Center — 3 agent lanes + handoffs + task queue. |
| `src/components/desktop/SettingsPage.tsx` | ~973 | Settings with tabbed sidebar (GitHub, Agents, Appearance, About). |

### Mobile Surface (separate from desktop)
| File | What |
|------|------|
| `src/components/mobile/mobile-remote-shell.tsx` | Mobile shell (~400 lines) |
| `src/components/mobile/hooks/` | 5 hooks: state, polling, scroll, streaming, actions |
| `src/components/mobile/controller*.ts` | Controller barrel + 3 domain files |

### API Routes (`src/app/api/`)
- `/api/mobile/inbox` — Agent sessions list
- `/api/mobile/history` — Session transcript
- `/api/mobile/cortex/*` — Cortex memory (recall, health, resolve, context, graph)
- `/api/panel/timeline` — Day timeline (CLI + JSONL based)
- `/api/panel/issues` — GitHub issues
- `/api/panel/prs` — GitHub PRs
- `/api/panel/universal-search` — 5-provider search
- `/api/panel/approvals` — Approval cards
- `/api/panel/github-status` — GitHub connection check

### Cortex Memory Integration
- Client: `src/lib/cortex/client.ts` — CLI wrapper for `~/bin/cortex` binary
- Types: `src/lib/cortex/types.ts`
- 6 UI components: FactCard, RecallPanel, MemoryContext, CortexStatus, MemoryHealth, GraphExplorer

### Runtime Adapters (`src/lib/runtimes/`)
Universal `AgentRuntime` interface with registry pattern:
- `openclaw.ts` — OpenClaw agent adapter
- `codex.ts` — Codex terminal sessions
- `claude-code.ts` — Claude Code CLI sessions

## Design Constants
```
Colors:
  --blue: #2563eb       (accent)
  --red: #ef4444        (brand, send button, settings gear)
  --bg: #f5f7fb         (light theme background)
  --panel: rgba(255,255,255,0.82)
  --text: #111827
  --muted: #5b6475

  Status dots: running=#22c55e, idle=#9ca3af
  Timeline: coding=#2563eb, thinking=#93c5fd, testing=#f59e0b, error=#ef4444
  Agent dots: Mister=#111827, Niot=#2563eb, Hawk=#f59e0b

Radii: 14px cards, 12px buttons, 10px pills, 8px tags
Touch: 44px minimum targets (Apple HIG)
Spring: cubic-bezier(0.32, 0.72, 0, 1)
Letter spacing: -0.01em body, -0.02em headings, -0.03em hero
Font: system-ui, SF Mono/Menlo for monospace
```

## Critical Rules

### NEVER DO
- **Never use CSS classes** — inline styles only (iOS Safari reliability)
- **Never use emoji** — Lucide icons only
- **Never use Material Design patterns** — no borderLeft accents, no MD elevation
- **Never push to main without building first** — `npx tsc --noEmit` before every commit
- **Never use Lucide React components in Tauri webview** — use raw `<svg>` elements (they render as empty boxes)
- **Never put early `return null` before hooks** — Rules of Hooks: all hooks must run in same order every render

### ALWAYS DO
- **Apple HIG enforcement**: 44px touch targets, 14px card radii, spring curves
- **Inline styles on everything**: `style={{ }}` props, not className
- **`as React.CSSProperties`** when using vendor-prefixed or non-standard CSS props
- **Test with `npx tsc --noEmit`** before committing
- **Keep the Steve Jobs eye**: density, restraint, progressive disclosure, "would Apple ship this?"

## Current State of AgentPanel (most active file)
The AgentPanel groups agents by repo/workspace:
- **Repo groups**: "Cortex IDE", "OpenClaw", "Spear", etc.
- **Status sections** inside each group: In Progress (blue), Idle (gray), Done (green)
- **Agent naming**: OpenClaw agents → actual name (Mister/Niot/Hawk). Repo agents → editor name (Codex/Claude Code)
- **Scrolling**: Whole panel scrolls with hidden scrollbar
- **Adaptive sizing**: Panel hugs content, grows naturally

## Workflow Reference
See `docs/canonical-workflow.md` for the full product workflow.

## Git Practices
- All work on `main` branch (no feature branches for rapid iteration)
- Small, focused commits with descriptive messages
- `git push origin main` after each commit
- Test before commit: `npx tsc --noEmit`

## What Needs Work (Open Issues)
- **#99** — Real-time WebSocket streaming (p1)
- **#100** — Issue → Agent assignment (p1)
- **#109** — Outbound alert delivery (p1)
- **#110** — Desktop chat send shell escaping (p0)
- **#113–#115** — Session Timeline phases 2–4
- **#116** — GitHub Connection settings wiring
- Intent Canvas wired to real data (currently mock)
- AgentPanel wired to real workspace/repo data (mock + real coexist)
- Terminal/Analytics nav sections not yet wired
- Settings stubs (Agents, Appearance, About tabs) need implementation
