# o8 Desktop — Design Language (v1)

The authoritative reference for styling every surface in the o8 desktop app. A sister spec to `o8-site/THEME.md` — shared lineage, different medium.

If you are building or touching any surface in this app, read this first. If a choice is not covered here, derive it from the principles. If a rule here is wrong, update this file before you ship the exception.

**Desktop app context** — native macOS Tauri v2 shell + Next.js 16. Different constraints than the marketing site: this one runs inside a vibrancy-backed NSWindow, reloads on file change, and renders through a WKWebView that has its own quirks.

---

## Table of contents

- [00 — Where this fits](#00--where-this-fits)
- [01 — Palette](#01--palette)
- [02 — Typography](#02--typography)
- [03 — Space & rhythm](#03--space--rhythm)
- [04 — Layout primitives](#04--layout-primitives)
- [05 — Vibrancy & surfaces](#05--vibrancy--surfaces)
- [06 — Motifs](#06--motifs)
- [07 — Components](#07--components)
- [08 — Copy voice](#08--copy-voice)
- [09 — Motion](#09--motion)
- [10 — Accessibility](#10--accessibility)
- [11 — Hard invariants](#11--hard-invariants)
- [12 — Theme switching](#12--theme-switching)
- [13 — Bridge to o8-site](#13--bridge-to-o8-site)
- [14 — Canonical examples](#14--canonical-examples)

---

## 00 — Where this fits

### Two design surfaces, one brand

| | o8-site (marketing) | o8 desktop (product) |
|---|---|---|
| Medium | Static web | Native macOS app |
| Backdrop | Paper (`#F4F2ED`) full bleed | macOS vibrancy passthrough |
| Type | Inter, 400/500 only | Plus Jakarta Sans, 300–800 |
| Chrome | Hairlines + whitespace | Glass over vibrancy |
| Content surfaces | Paper | Paper (light) / ink (midnight) |
| Layout | Single-column scroll | Panels + tiles |

Both share: the `#FF5A1F` orange accent, the `#B8C8D8` structural blue, the copy voice (numbered sections, bracketed labels, no hype), the accessibility floor.

### The "is this chrome or content" test

Before picking colors for any new surface, ask:

- **Chrome** — nav rail, sidebar, title bar, tab bar, panel frames, command palette, popovers, menus, status bar. These pass the macOS vibrancy through. Glass tokens. Transparency.
- **Content** — chat transcripts, code in the canvas, terminal output, orchestrator chat, file diff viewer. These are reading surfaces. Solid paper (light) or solid ink (midnight). No transparency.

Chrome bleeds. Content doesn't.

---

## 01 — Palette

### Content surfaces (solid)

These are the reading surfaces — workspace canvas, chat panels, terminal output. They NEVER pass vibrancy through.

| Token | Light | Midnight | Role |
|---|---|---|---|
| `--t-canvas-bg` | `#F4F2ED` | `#1a1e24` | Workspace / code viewer |
| `--t-chat-surface-bg` | `#F4F2ED` | `#1a1e24` | LLM chat, orchestrator chat |
| `--t-terminal-bg` | `#F4F2ED` | `#16191e` | PTY terminals |
| `--t-chat-surface-text` | `#0f172a` | `#e8ecf2` | Primary text on content |
| `--t-chat-surface-text-secondary` | `#475569` | `#b7bfca` | Secondary text on content |
| `--t-chat-surface-text-muted` | `#64748b` | `#8a93a0` | Tertiary labels on content |

**Light-mode content surfaces use paper (`#F4F2ED`) — not `#ffffff`.** Matches the landing's paper tone so the brand feels continuous between the marketing site and the product.

### Chrome (translucent)

Surrounding panels, nav rails, tab bars, popovers. These pick up the vibrancy.

| Token | Light | Midnight | Role |
|---|---|---|---|
| `--t-chrome` | `transparent` | `transparent` | Forced transparent in Tauri; vibrancy shows through |
| `--t-panel` | `rgba(255, 255, 255, 0.58)` | `rgba(62, 68, 78, 0.36)` | Glass panels |
| `--t-bg` | `rgba(250, 251, 253, 0.62)` | `rgba(22, 25, 30, 0.56)` | Secondary glass |
| `--t-bg-card` | `rgba(255, 255, 255, 0.74)` | `rgba(62, 68, 78, 0.48)` | Card surfaces over chrome |
| `--t-border` | `rgba(15, 23, 42, 0.08)` | `rgba(255, 255, 255, 0.08)` | Hairline dividers |

**Never hardcode `rgba(255, 255, 255, 0.xx)` as a chrome surface.** Use `--t-panel` / `--t-bg-card`. The rgba-white approach looks correct in light but becomes a bright blob over midnight's vibrancy. See commit `929ffdf` for the repo-wide sweep that fixed this.

### Accent

| Token | Value | Use |
|---|---|---|
| `--t-accent` | `#2563eb` (legacy brand blue) | Primary interaction blue in product |
| `--t-brand-orange` | `#FF5A1F` | Status LEDs, merge-success dots, focus rings (matches landing) |
| `--t-brand-red` | `#ef4444` | Error states, destructive confirmations |

The product currently uses `#2563eb` blue as its primary action color. The landing's `#FF5A1F` orange is imported as `--t-brand-orange` for surfaces where the two should visually align (e.g. an `o8` wordmark, a status LED on the UpdateBanner).

### Structure (diagrams)

| Token | Value | Use |
|---|---|---|
| `--t-structure` | `#B8C8D8` | Diagram fills, empty-state halftones, glow trails |

Matches the landing's structural blue. Already in light use on empty states; formalizing as a token makes it tokenized.

---

## 02 — Typography

### Font — LOCKED

**Plus Jakarta Sans** stays as the primary. Do not swap for Inter, Neue Haas Grotesk, or anything else. The font has three years of product equity and the weight stack (300–800) is already load-bearing for hierarchy contrast.

Mono remains SF Mono / Menlo / Consolas fallback chain.

### Weight scale

| Weight | Use |
|---|---|
| 300 | Tiny metadata — timestamps, build stamps |
| 400 | Body copy, transcript messages, terminal output |
| 500 | UI labels, tab titles, section heads |
| 600 | Action buttons, bold transcript names |
| 700 | Display headlines, app title |
| 800 | Rare — hero display only (dashboard first-load state) |

### Size scale

| Token | Size | Use |
|---|---|---|
| `display` | `44–72px` | Dashboard hero / onboarding |
| `h1` | `28px` | Settings page section heads |
| `h2` | `20px` | Panel heads, modal titles |
| `h3` | `16px` | Card titles, tab labels |
| `body` | `14px` | Chat messages, transcript lines, terminal output |
| `body-s` | `13px` | Nav labels, tooltip text, button copy |
| `meta` | `12px` | Status bar, port chips, timestamps |
| `micro` | `11px` | Numbered section labels (in widgets that adopt landing rhythm) |

### Landing-style label primitives

When a surface wants to borrow the editorial rhythm from the landing (settings page, first-run wizard, empty states), use:

- **Section label** — small-caps wide-tracked `00 — LABEL` (11px, `letterSpacing: 0.22em`, `--t-text-muted`)
- **Bracketed micro-label** — mono parenthesized `(FEATURE)` (11px mono, `letterSpacing: 0.04em`)
- **Mono stamp** — `v0.1.7` / `2026-04-17 13:00 UTC` (11px mono, `letterSpacing: 0`)

Use sparingly. This is the landing's rhythm, not the default app chrome.

---

## 03 — Space & rhythm

### Base unit

8px. All padding, gap, and margin values are multiples of 8. Exceptions are explicit: 14px card radii, 1px hairlines.

### Radius scale

Apple HIG-aligned:

| Radius | Use |
|---|---|
| 8px | Tags, pills, small badges |
| 10px | Buttons, containers |
| 12px | Secondary cards |
| 14px | Primary cards (chat card, repo card, settings card) |
| 16px | Modals, full-screen overlays |

### Touch targets

**44px minimum** for all interactive elements (Apple HIG). Hover zones may expand beyond the visible element.

---

## 04 — Layout primitives

The dashboard composition, from top to bottom:

```
┌─────────────────────────────────────────────────┐
│ TitleBar (44px, drag region, traffic lights)    │
├─────────────────────────────────────────────────┤
│ SessionTimeline (36px, day-level activity)       │
├──────┬──────────────────────┬───────────────────┤
│ Nav  │    AgentPanel (left)  │  Center Workspace │
│ Rail │    or IntentCanvas    │  (Canvas/Settings)│
│ 56px │    or SettingsPage    │                    │
└──────┴──────────────────────┴───────────────────┘
```

### Key containers

| Element | File | Notes |
|---|---|---|
| Main layout | `src/app/dashboard/page.tsx` | Layout orchestrator — do not expand, keep as thin composer |
| Agent panel | `src/components/desktop/AgentPanel.tsx` | Left-side repo/agent view |
| Workspace terminal | `src/components/desktop/workspace-terminal/` | Center tabbed workspace |
| Orchestrator tab | `workspace-terminal/OrchestratorTab.tsx` | Full-width orchestrator surface |
| LLM chat | `src/components/desktop/LLMChat.tsx` | Assistant surface |

### Asymmetry

The desktop layout is not centered. Content lives against a firm left edge (NavRail). Panels on the right (Changes) float over vibrancy. No surface is horizontally centered.

---

## 05 — Vibrancy & surfaces

### macOS vibrancy

The Tauri sidecar applies `NSVisualEffectMaterial::HudWindow` unconditionally at startup (`src-tauri/src/lib.rs`). HudWindow is a dark-tinted material — it makes light-tinted rgba panels look silver-grey rather than white, which is intentional for the midnight aesthetic.

### Forced transparency

The `ThemeProvider` forces these tokens to `transparent` regardless of theme, so the vibrancy passes through:

- `--t-chrome`
- `--t-bg-gradient`
- `--t-chrome-nav`

This is a hard rule. Never override them with a hex color.

### Solid content surfaces

The three "paper" surfaces paint on top of the vibrancy with a solid fill:

- `--t-chat-surface-bg` — chat reading surfaces
- `--t-canvas-bg` — code/file viewer
- `--t-terminal-bg` — PTY output

These are NEVER transparent. They use paper (`#F4F2ED`) in light and ink (`#1a1e24` / `#16191e`) in midnight. Text needs a stable background to read.

### When in doubt

If you're painting a new surface, ask: "is this something the user READS for 30+ seconds, or is this chrome around the reading?" Reading → solid. Chrome → glass.

---

## 06 — Motifs

The desktop app has its own motif vocabulary, distinct from the landing's 7 figures. Don't try to render a spectrum slider in the app.

### 06.1 Card

Primary container for everything that isn't chrome. Rounded 14px, paper/ink fill, 1px hairline border, soft shadow. See `RepoCard`, chat cards, settings cards.

### 06.2 Pill label

Small rounded rectangle, ink fill, paper text. Used for status chips, session state badges. 28px height, `rx: 14`, uppercase text at 11px.

### 06.3 Hairline divider

1px at 8% opacity. Between sections, between list rows, between columns. Never borders or elevations.

### 06.4 Status dot (LED)

3–4px filled circle. Colored by state:
- `#22c55e` — running, live
- `#9ca3af` — idle, paused
- `#ef4444` — error, blocked
- `#FF5A1F` — attention required

Paired with text, never standalone.

### 06.5 Phosphor raw-SVG icons

Icons are raw `<svg>` elements. Never use `@phosphor-icons/react` or `lucide-react` React components — they don't render correctly in the Tauri webview. Extract path data from `@phosphor-icons/react/dist/defs/` and inline the SVG. For simple glyphs (plus, minus, check), prefer HTML entities.

See `src/components/shared/icons/` for the established pattern. Shim system documented in memory `lucide_shim_system.md`.

### 06.6 Session timeline

Horizontal strip above the workspace showing day-level activity (coding / thinking / testing / error). 36px tall. Muted colors, no bold. See `SessionTimeline.tsx`.

---

## 07 — Components

### TitleBar
44px tall. Drag region for the Tauri window. Traffic lights left. Command palette search center. Notification bell right.

### NavRail
56px wide. Vertical stack of Phosphor raw-SVG icons. Active icon gets a hairline accent stripe on the left edge. Hover reveals a portal-positioned label (see `feedback_portal_hovers` — framer-motion transforms break fixed positioning, so labels must `createPortal`).

### Workspace terminal
Tabs across the top. Each tab has a `kind` field (orchestrator / assistant / terminal / chat). The Orchestrator tab is a three-pane layout (History / Chat / Mission).

### RepoCard
The primary branch / agent grouping in the AgentPanel. 14px rounded, paper/ink surface, hairline border. Expanded state shows branch rows + commit history.

### Chat panel (LLM / orchestrator)
Solid content surface (paper in light, ink in midnight). Messages left-aligned, bubble style. User messages right-aligned with accent tint. Message composer at the bottom with a hairline top border.

### Terminal (PTY)
Full-height solid surface. Monospace. Matches `--t-terminal-bg`. Thin scrollbar styled to match the theme.

### Settings page
Sectioned with the landing's editorial rhythm. Uses section labels (`01 — ACCOUNT`), bracketed micro-labels, hairline dividers. Controls are inline-style React inputs; no native `<select>` in packet cards.

---

## 08 — Copy voice

Same rules as the landing (`o8-site/THEME.md` §08).

- Thesis-first. Short sentences. No exclamation marks.
- No hype adjectives ("powerful", "seamless", "revolutionary").
- Numbered sections when the content has a rhythm.
- Bracketed mono labels `(FEATURE)` `(STATUS)` `(SESSION)` for structural callouts.
- Monospace for timestamps, hashes, version stamps.

### Console logging

Every console log gets a `[feature-name]` prefix. See CLAUDE.md for examples: `[memory-recall]`, `[compaction]`, `[reconcile]`, `[orchestrator-session]`.

### Commit prefixes

`feat:` `fix:` `refactor:` `perf:` `chore:` `docs:` `design:` — these are the surviving prefixes after the public changelog filter scrubs. If you want a commit to land on the public log, use `feat:` / `perf:` / `design:`.

---

## 09 — Motion

Framer Motion with restrained curves.

- Spring: `stiffness: 400, damping: 30` — the default for all interactive transitions
- Duration-based: 150ms for hover states, 200ms for panel slides, 300ms for tab switches
- No bounce. No scale-on-hover > 1.02. No parallax.

### Specifically banned

- Loading spinners on fast operations (< 500ms)
- Typewriter text reveals
- Confetti, particles, celebratory animations
- Auto-advancing carousels
- Any motion that re-triggers on scroll

---

## 10 — Accessibility

### Contrast

All text-on-surface combinations must meet WCAG AA on both themes:

- `--t-text` on content surface: ≥ 14:1 (pass)
- `--t-text-muted` on content surface: ≥ 4.8:1 (pass)
- `--t-brand-orange` on paper: 3.9:1 — non-text only

### Focus states

Every interactive element has a visible `:focus-visible`:

```css
*:focus-visible {
  outline: 2px solid var(--t-accent);
  outline-offset: 2px;
  border-radius: 2px;
}
```

### Keyboard

All dispatch / merge / approval actions are keyboard reachable. Tab order follows visual order (left to right, top to bottom). No mouse-only affordances.

### Reduced motion

`@media (prefers-reduced-motion: reduce)` — framer-motion respects this via `useReducedMotion()`. All spring transitions fall back to 0ms.

---

## 11 — Hard invariants

Rules that are permanent. No exceptions, no grandfather clauses.

### NEVER

- **Never use CSS classes.** Inline styles only (`style={{ }}` props). iOS Safari reliability issue. This is permanent.
- **Never hardcode rgba colors for surfaces.** Use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`. Hardcoded `rgba(255, 255, 255, 0.xx)` becomes a light-gray blob in midnight. See commit `929ffdf`.
- **Never hardcode port 3001 or 3002.** Use `getApiBase()` from `@/lib/panel/api-port`. The Tauri sidecar picks ports dynamically.
- **Never hardcode `/Users/marquisehurtt/*` paths.** Use `process.cwd()`, `os.homedir()`, `process.env.HOME`.
- **Never use emoji.** Raw SVG only. Phosphor path data via `@phosphor-icons/react/dist/defs/`.
- **Never use React icon components in Tauri webview.** Neither `@phosphor-icons/react` nor `lucide-react` render correctly. Raw SVG via the shim system.
- **Never use dropdown overflow menus ("...")** — use inline actions with confirmation strips.
- **Never put early `return null` before hooks** — React rules of hooks, all hooks run in the same order every render.
- **Never use CSS shorthand for padding/margin** — use `paddingTop` / `paddingLeft`, not `padding: "8px 16px"`. React 19 warns on mixed shorthand/longhand.
- **Never throw in API routes** — return structured error responses via `buildErrorPayload`.
- **Never bypass the middleware in `src/middleware.ts`** — gates all dangerous API routes on loopback + ws-token.
- **Never use Material Design patterns** — no borderLeft accents as emphasis, no MD elevation tiers.
- **Never reintroduce retired orchestrator tile kinds** — `thoughts`, `mission-control`, `orchestrator-history` are deleted. The Orchestrator is a tab inside `WorkspaceTerminal`.
- **Never add NavRail launchers for orchestrator/mission/history** — nav rail bottom is reserved for ports, alerts, settings.
- **Never use native `<select>` or `<input>` inside packet cards** — custom popover rows only.

### ALWAYS

- `npx tsc --noEmit` before every commit
- Respect the 800-line file ceiling — decompose before adding more lines. `page.tsx` and `ws-server.ts` are waived.
- Apple HIG: 44px touch targets, 14px card radii, spring curves
- `as React.CSSProperties` when using vendor-prefixed or non-standard CSS props
- Build for both runtimes — Codex and Claude Code. The adapter interface allows adding new runtimes later.
- Console logging prefix `[feature-name]`
- Commit prefix `feat:` / `fix:` / `refactor:` / `perf:` / `chore:`
- Public changelog safety — `.github/workflows/sync-changelog.yml` scrubs commit messages before public sync. Add new internal codenames to BOTH the sed filter AND the blocklist.

Full list lives in `CLAUDE.md`. This doc summarizes; that file is authoritative for invariants.

---

## 12 — Theme switching

### Current state

Two themes ship: **light** and **midnight**. The legacy `dark` theme auto-remaps to `midnight` via `LEGACY_THEME_IDS` in `src/lib/theme/context.tsx`.

### How tokens are applied

`ThemeProvider` applies CSS variables to the `<html>` root. Components reference `var(--t-*)` tokens inside inline styles:

```tsx
<div style={{ background: "var(--t-bg-card)", color: "var(--t-text)" }}>
```

Components never import palette hex values directly. All palette access flows through tokens.

### Persistence

User's theme choice persists to `localStorage` under key `cortex-theme`. Override via URL param `?theme=light|midnight` for debugging.

### When adding a new surface

1. Pick the two-theme values from the palette table (§01)
2. Define tokens in `src/lib/theme/index.ts`
3. Reference in component via `var(--t-your-new-token)`
4. Verify both themes render correctly
5. Check contrast ratios hit AA

Never hardcode. Never inline a hex outside the token system.

---

## 13 — Bridge to o8-site

When a surface in the app wants to reference the marketing site's aesthetic, follow these rules:

### Keep (shared)
- `#FF5A1F` orange accent — same token both places
- `#B8C8D8` structural blue
- Paper `#F4F2ED` on content surfaces in light mode
- Numbered section labels
- Bracketed mono labels
- Copy voice

### Translate (different context)
- Font: site uses Inter 400/500, app uses Plus Jakarta Sans 300–800
- Backdrop: site is full-paper, app is glass-over-vibrancy
- Layout: site is single-column scroll, app is panel+tile composition
- Motifs: site has 7 editorial figures, app has cards + pill labels + timeline

### Canonical coherence moments
- The `o8` wordmark + crosshair in `SiteNav` → matches the app's title bar wordmark when that surface is updated
- Landing's `(TRUST)` strip tone → the app's first-run wizard should echo the same bracketed-label rhythm
- Landing's download CTA typography → the app's UpdateBanner download prompt should mirror the mono-meta line underneath

If you're ever unsure whether a treatment is shared or diverges, ask. Don't guess.

---

## 14 — Canonical examples

### Content surface (chat panel)

```tsx
<div style={{
  background: "var(--t-chat-surface-bg)",
  color: "var(--t-chat-surface-text)",
  paddingTop: "16px",
  paddingBottom: "16px",
  paddingLeft: "20px",
  paddingRight: "20px",
  borderRadius: "14px",
}}>
  {/* chat messages */}
</div>
```

### Chrome surface (NavRail)

```tsx
<nav style={{
  background: "var(--t-panel)",
  borderRight: "1px solid var(--t-border)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
}}>
  {/* icons */}
</nav>
```

### Status LED

```tsx
<span
  aria-hidden
  style={{
    display: "inline-block",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: isRunning ? "#22c55e" : "#9ca3af",
  }}
/>
```

### Section label + bracketed micro-label (landing rhythm)

```tsx
<div style={{ display: "flex", alignItems: "baseline", gap: "20px" }}>
  <span style={{
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: "var(--t-text-muted)",
  }}>
    01 — Workspace
  </span>
  <span style={{
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    fontSize: "11px",
    letterSpacing: "0.04em",
    color: "var(--t-text-muted)",
  }}>
    (SESSION)
  </span>
</div>
```

---

## Provenance

- **v1** locked 2026-04-17 — alongside the landing site's THEME.md v1 Light lock.
- Palette update: content surfaces in light mode switched from `#ffffff` to `#F4F2ED` (paper). Chrome unchanged.
- Typography locked — Plus Jakarta Sans stays. No Inter swap.
- Sister spec: `o8-site/THEME.md` — marketing side.
- Authoritative implementation: `src/lib/theme/` — token definitions live there.

If this doc conflicts with the code, **the doc wins** and the code is a bug. File an issue, fix it.

If this doc conflicts with `CLAUDE.md`, `CLAUDE.md` wins — it's the single source of truth for hard invariants. This doc summarizes and explains.
