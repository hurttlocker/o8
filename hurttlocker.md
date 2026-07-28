# Hurttlocker — locked theme spec

This is the operator's **canonical style and font spec** for o8, captured after the 2026-05-25 sidebar polish pass. When the next-level theming work begins from scratch, **start here.** Every value below is locked — verified by eye against the [`/preview/typography`](src/app/preview/typography/page.tsx) lab, then dialed and shipped.

If a future surface disagrees with these tokens, the new surface should match these tokens — not the other way around — unless the operator explicitly relaxes the lock.

---

## Font family

System stack, no webfont. Decided after the Plus Jakarta Sans pass was rolled back: the macOS SF Pro / SF Pro Display hinting + the lighter weights we use look better than any imported font we tested.

```css
font-family: var(--font-sans-system);
/* resolves to */
-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display",
  "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif;
```

---

## Typography tokens (locked — GLOBAL, every surface)

**This table is canonical for every chrome surface in o8 and any project we build going forward.** If the surface has text, it should land in one of these rows or read as a deliberate exception. Locked 2026-05-27 after the o8-panel + popover + workspace-tab sweep brought the entire app into spec.

| Role | Size | Weight | Letter-spacing | Line-height | Notes |
|---|---|---|---|---|---|
| **Row title** (chat row, agent row, packet row, popover row, file row) | 13.5 px | **300** | **−0.1 px** | **1.25** | Light weight is load-bearing — drops the visual noise that a 400-weight body would carry. |
| **Row meta** (subtitle under title, path subline, owner badge, timestamp, hash, count) | 9.5 px | **260** | **−0.4 px** | **1.25** | Very thin, very tight. Reads as a soft second-tier label, not as competing content. |
| **Section label** (Open now / Archived / Spawned agents / Progress / Environment / TODAY / Proposed directives) | 10 px (or 9 px uppercase) | **300** | **−0.1 px** (or 0.04em if uppercase) | 14 px | NO bold. Uppercase is fine but always small + thin + faint (`var(--t-text-faint)`). |
| **Chrome label inline** (composer chips, mode chips, tab pills, toolbar buttons) | 11–12 px | **300** | **−0.1 px** | **1.25** | Active state distinguished by background + color, NEVER by going bold. |
| **Tab pill** (workspace tab, O8 panel header tab) | 12 px | **300** | **−0.1 px** | **1.25** | Height **26**, radius **7**, no border. Active = subtle bg fill (`var(--t-input-bg)`), inactive = transparent → hover. |
| **Body text** (markdown body, notes editor body, message bubble) | 13–13.5 px | **300** | **−0.1 px** | **1.45–1.55** | System stack — never `Inter`-locked. |
| **Heading** (MD h1) | 18 px | **400** | **−0.2 px** | 1.25 | Was 21/700 — light + tight reads as editorial not blog. |
| **Heading** (MD h3) | 13.5 px | **400** | **−0.1 px** | 1.25 |  |
| **Strong** (markdown `**bold**`) | inherit | **500** | inherit | inherit | Never 600+. 500 is the cap for inline emphasis. |
| **Banner / status text** (Reconnecting, Read-only mode, Loading…) | 11 px | **300–400** | **−0.1 px** | 1.35 | Strong label part can ride at 400 if it's a one-word severity; body sub always 300/faint. |
| **Computed CSS spec** for sliders → code | see below | | | | The lab's "Computed CSS" pane is the source of truth. |

### The two anti-patterns

These are bugs, not choices:

1. **`fontWeight: 500/520/540/560/600/650/700/750/800` anywhere on chrome.** Cap is 500 (used only for inline `<strong>`). Tab pills, popover headers, row titles, section labels, badges — all 300. Active state never bumps weight.
2. **Hard-coded `'Inter'` (or any webfont).** Always system stack via `var(--font-sans-system)`. The PROSE constant in `O8SpecEditor` was the last holdout — fixed 2026-05-27. SF Pro's variable axis renders 300 as a true thin where Inter renders it as 400-equivalent on macOS.

The numbers above are not negotiable. They came out of a long visual tuning session against a Claude desktop reference, then got committed across every list surface in [`src/components/desktop/`](src/components/desktop/).

### Where each token lives in code

- `src/components/desktop/repo-focus/tabs/chats/HistoryRows.tsx` — `HistoryChatRow`, `CompactSessionRow`, `MergedPacketRow`, `ArchivedLaneCompactRow`
- `src/components/desktop/repo-focus/tabs/AgentRows.tsx` — `SessionRow`, `PacketRow`
- `src/components/desktop/repo-focus/tabs/chats/shared.tsx` — `SectionLabel`, `RepoGroupLabel`
- `src/components/desktop/AgentPanelExtraAgents.tsx` — `GroupHeader`, `ExtraAgentRowView`

### Title→meta vertical gap

`marginTop: 4 px` from title to meta line. Less than that and the two lines smush; more than that and the row feels like two unrelated items.

---

## Iconography rule

Lists are **text-first**. Leading icons (runtime glyphs, chat stars, etc.) were stripped from every chat-history row, agent row, and spawned-agent row on 2026-05-25.

What's left: a single **6 px colored status dot** in `ExtraAgentRowView` (green=running, orange=reviewing/waiting, gray=idle, red=failed). That's the only leading affordance. Everything else is just text.

Hover reveals delete / archive / context-menu actions — never default-visible. Pattern is cribbed from Claude desktop: progressive disclosure keeps the list dense but visually clean.

---

## Section-label alignment

Antigravity-pass column system (locked 2026-05-26 · verified panel-relative 2026-06-11):

All X values are **panel-relative** — measured from the floating card's left edge, not the window (the card sits at a small window offset that varies). Verified intact 2026-06-11 with computed styles on the live app.

- **Icon column (x=12, ish):** top-nav row icons (Play / Search / Automations / Delivery), repo folder glyphs, GroupHeader chevrons + folder glyphs. All sit with their left edge at the same paddingLeft (10–12 px depending on row type). Project identity rings (6px, `MiniProjectsMenu`) center on this column too.
- **Text column (x=37):** chat-row titles, spawned-agent titles, packet titles, top-nav text, **project names** (joined 2026-06-11 — they sat at 31 since the projects menu landed). Different row types compute different paddingLeft values because their leading icon column widths differ — but they all land at the same text X (37 px). Tweaking any leading geometry means re-doing the paddingLeft math.
- **Repo child rows (x=44):** sub-repo rows under an expanded project indent one clear step (+7) in from the parent text column (2026-06-11).
- **Section labels (x=29):** RepoGroupLabel / GroupHeader headers sit between the icon and text columns — `paddingLeft 12 + 11 px chevron-or-folder slot + 6 px gap = 29`. Less indent than rows, more indent than nothing — the headers visually "own" the rows below.

---

## Right-rail alignment (locked 2026-05-26 · re-snapped 2026-06-11)

Operator demands **pixel-perfect alignment** on the right edge of the agent panel. Anything that isn't on the column reads as misaligned to him — there is no "close enough."

**2026-06-11 re-snap:** the top-nav trailing glyphs changed from chevrons to disclosure glyphs (Lucide `Menu` 13px on New session, Iconoir `MenuScale` 12px on Projects) and had drifted 1–2px left of the optical column. Re-measured from rendered pixels at 4×, corrected with per-glyph `translateX` in `MiniAgentPanelAction` (`menu` → 9px, `filter` → 8px). The absolute X values below are from the spec-era panel; the panel is now a floating card and resizable, so the LOCK is the *relationships*, verified as deltas against the ring.

The right rail has three locked vertical columns (relationships, ring = reference):

| Column | What sits here | How it gets there |
|---|---|---|
| **ring + 2 (optical ink)** | Top-nav trailing glyphs (New session `Menu`, Projects `MenuScale`), filter-list icon (group picker on RepoGroupLabel) | Top-nav button `paddingRight: 10` + per-glyph `translateX(9px/8px)`. RepoGroupLabel `paddingRight: 10` + ChatGroupPicker button `justifyContent: 'flex-end'`. Because each glyph's ink insets differently from its bbox, the BBOX deltas vs ring are: filter +3, Menu +3, MenuScale +2 — which lands all three glyphs' visible ink on one column ~2px right of the ring. |
| **ring (reference)** | Active chat ring / pulse, spawned-agent ring, timestamps (`10h ago` etc.) | HistoryChatRow + ExtraAgentRowView `paddingRight: 12`. Trailing meta is a flex span with `gap: 6` — the ring sits at the end of that span. |
| **ring − 1** | Archived ring | ArchivedLaneCompactRow `paddingRight: 13` — explicitly 1 px left of the chat ring, so archived reads as quietly "set aside" rather than identical to live chats. |

### Why the optical column beats the math

Each glyph's visible ink ends a different distance inside its SVG bounding box (FilterList ~1.5px, Lucide Menu ~1px, MenuScale ~0.5px). Aligning bounding boxes makes the INK read misaligned. Land the ink, not the box. Operator's eye picks up a 1px step at one glance — don't trust the math, screenshot at 4× and measure the rendered pixel.

### How to verify after any change

Open the agent panel, then in the webview console:

```js
const m = (el) => Math.round(el.getBoundingClientRect().right * 10) / 10;
const r = m(document.querySelector('.o8-static-ring'));
const f = m(document.querySelector('button[aria-label="Change chat grouping"] svg'));
const by = (t) => Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === t);
const last = (b) => { const s = b.querySelectorAll('svg'); return m(s[s.length - 1]); };
console.table({ ring: r, dFilter: f - r, dNewSession: last(by('New session')) - r, dProjects: last(by('Projects')) - r });
```

Expected deltas (bbox, producing ink alignment): `dFilter 3, dNewSession 3, dProjects 2`. If a delta drifts — or a glyph is swapped — re-measure the ink at 4× zoom before snapping anything back.

### Files that own the columns

| Surface | File |
|---|---|
| Top-nav rows + chevrons | `AgentPanel.tsx` — `MiniAgentPanelRow`, `MiniAgentPanelAction` |
| Repo group header + filter | `repo-focus/tabs/chats/shared.tsx` — `RepoGroupLabel` + `repo-focus/tabs/chats/ChatGroupPicker.tsx` |
| Chat / spawned / archived rows | `repo-focus/tabs/chats/HistoryRows.tsx` — `HistoryChatRow`, `MergedPacketRow`, `CompactSessionRow`, `ArchivedLaneCompactRow` |
| Spawned agents row | `AgentPanelExtraAgents.tsx` — `ExtraAgentRowView` |

---

## Layout primitives

| Token | Value | Where |
|---|---|---|
| Row vertical padding | 5 px top + 5 px bottom | All chat / agent / packet rows |
| Row gap between rows | 0 px | Separators removed — rows touch, hover background is the only inter-row affordance |
| Section label paddingLeft | 12 px | Aligns RepoGroupLabel / GroupHeader / SectionLabel |
| Row paddingLeft | 37 px | Chat / spawned / archived rows — aligns row text X with top-nav text X (see Section-label alignment above) |
| Row paddingRight | 12 px (chats / spawned), 13 px (archived) | Right rail alignment column at x=233 / 232 (see Right-rail alignment) |
| Top-nav paddingLeft / paddingRight | 10 / 10 px | MiniAgentPanelRow + MiniAgentPanelAction — chevron at x=235 |

### Mask gradient (scroll fade)

```css
/* AgentPanel scrollable list */
mask-image: linear-gradient(
  to bottom,
  transparent 0px,
  black 16px,
  black calc(100% - 32px),
  transparent 100%
);
```

16 px fade at the top (content emerges from nav above), 32 px fade at the bottom (chats melt into the button dock). Same shape on `-webkit-mask-image` for Safari/Tauri.

---

## Color tokens used by the sidebar

These are theme tokens — they swap by `ThemeProvider`. The values below are reference (light theme) but the rule is **always use the token, never hard-code an rgba**.

| Token | Light value (reference) | Used for |
|---|---|---|
| `--t-text` | `#0f172a` | Row title text |
| `--t-text-muted` | `#5b6475` | Inline subtitle on `ExtraAgentRowView` |
| `--t-text-faint` | gray-400 region | Section labels, meta text, count badges |
| `--t-hover` | `#f4f4f5`-ish translucent | Single hover affordance on rows |
| `--t-divider-subtle` | barely-there gray | No longer on row separators (removed). Reserved for section divisions. |
| `--t-panel` | translucent white | List container background |
| `--t-panel-hover` | slight tint | Extra row hover variant |

**Hard rule from `CLAUDE.md` reinforced here:** never hard-code `rgba(255, 255, 255, 0.xx)` on a surface that needs to theme — it collapses to a light-gray blob in midnight. Always reach for a `var(--t-*)` token.

---

## Hover state

Single pattern, used everywhere:

```css
background: transparent;  /* default */
/* on mouseenter */
background: var(--t-hover);  /* subtle gray bg */
```

No border accents, no scale transforms, no shadow growth on hover. The background swap is the only feedback. The Claude reference proved this is enough.

---

## Reference: typography lab page

The live tuner at [`/preview/typography`](src/app/preview/typography/page.tsx) has:
- 4 presets (Current / Thinner / Claude-like / Cursor-dense)
- Sliders for every property in the locked spec
- Live render of "Today / May 22 / May 20 / Older" sections with 9 sample rows
- Computed CSS box at the bottom that updates with the current values

**Use it when:**
- Trying a new font weight, letter-spacing, or row geometry
- Adjusting line-height for density vs breathing room (current value 1.25 is the dialed-in target)
- Comparing a future redesign against the locked baseline

**Don't ship from this page** — values land in component files only after the operator visually confirms.

---

## Icon vocabulary (locked 2026-05-25)

The visual style for chrome icons is decided. Two icon libraries are wired into the app via raw-SVG shims (the Tauri webview can't render `lucide-react` or `@tabler/icons-react` as React components — same bug for both — so each shim imports the icon's `__iconNode` data array and renders inline `<svg>` via `createElement`).

| Library | Shim file | Use for |
|---|---|---|
| **Lucide** (~1,500 icons) | `src/components/desktop/lucide-shims.tsx` | Default chrome icon set. Most app surfaces (nav, toolbars, buttons, menus). |
| **Tabler** (~5,400 icons) | `src/components/desktop/tabler-shims.tsx` | Operator-locked picks where Tabler's glyph design wins. Currently: **Terminal**, **GitBranch**. |
| **Iconoir** (~1,600 icons) | not yet shimmed | Sidekick for spots where Lucide reads too neutral and Tabler too geometric. Wire on demand. |
| **Isocons** (1,000+ isometric, CC BY 4.0) | not yet integrated | Decorative / hero / empty-state illustrations only. Never chrome. Attribution required when used. |

### Locked Tabler picks

| Icon | Lucide name (was) | Tabler glyph | Why Tabler wins |
|---|---|---|---|
| **Terminal** | `Terminal` | `IconTerminal2` (`@tabler/icons-react/dist/esm/icons/IconTerminal2.mjs`) | Tighter geometry, reads better at 14px in the bottom status bar dock. Lives in `DesktopStatusBar.tsx` (`TerminalGlyph` now delegates to Tabler). |
| **GitBranch** | `GitBranch` | `IconGitBranch` (`@tabler/icons-react/dist/esm/icons/IconGitBranch.mjs`) | Cleaner stroke termini. Swapped across `MessageActions.tsx`, `MergeActionCluster.tsx`. |

### Locked Iconoir picks

Iconoir's React components render correctly in the Tauri webview — no shim needed. Import directly from `iconoir-react`.

| Icon | Phosphor / Lucide (was) | Iconoir glyph | Where it lives |
|---|---|---|---|
| **FolderPlus** | Phosphor folder-plus hand-drawn SVG | `FolderPlus` | `desktop-status-bar/status-bar-icons.tsx` (`FolderPlusIcon` now delegates). Used on the Add-repo affordance in the bottom status bar dock. |
| **Internet** (globe + cursor) | 6px green square | `Internet` | `desktop-status-bar/footer-ports.tsx` — leading icon on every web-port row in the ports popover. Telegraphs "click to open in browser." |
| **Mail / MailOpen** | `WarningCircleIcon` (filled vs outlined) | `Mail` when inbox has unread items, `MailOpen` when quiet | `desktop-status-bar/supervisor-inbox-badge.tsx`. Reads more "inbox" than a warning glyph. |
| **MobileDevMode** | Phosphor `device-mobile` (plain phone) | `MobileDevMode` (phone with `<>` inside) | `desktop-status-bar/status-bar-icons.tsx` (`DeviceMobileIcon` now delegates). Bottom-left dock button. The `<>` marker matches what the button does — open the mobile pairing/dev surface. |
| **PageEdit** | (was `CircleSpark` — moved to scratch chat) | `PageEdit` (document + pencil) | `o8-panel/O8HeaderTabs.tsx`, the `o8.md` spec tab. Document + pencil reads as "the spec the agent is annotating." |
| **CircleSpark** | Hand-rolled message-square SVG | `CircleSpark` (circle + spark) | `O8Panel.tsx` `ChatIcon`. Used for the side / scratch chat. Fits "spark a quick thought" semantics. |
| **DoubleCheck** | Sparkle SVG | `DoubleCheck` (two checks) | `o8-panel/O8SpecPane.tsx`, the "Ask o8 to review" TitleBarButton in the o8.md header. Two checks reads as "AI-validated" / "agent verified." |
| **FolderSettings** | Lucide `Folder` | `FolderSettings` (folder + gear) | `AgentPanel.tsx` Projects row (top-left nav). Suggests "configure projects" rather than just "open folder." |
| **AutoFlash** | Lucide `Zap` | `AutoFlash` (lightning + A) | `AgentPanel.tsx` Automations row. The "A" marker reads as "automated" — more specific than a bare lightning bolt. |
| **InputSearch** | Lucide `Search` | `InputSearch` (pill + magnifier) | `AgentPanel.tsx` Search row. Pill shape telegraphs "type to search" better than a standalone magnifier. |
| **CircleSpark (re-used)** | Hand-rolled twin-sparkle SVG | `CircleSpark` | `o8-panel/workspace-rail/O8ScratchChat.tsx` `AskO8Icon`. Now also appears on the o8.md panel (was hidden before). Same icon as the side/scratch chat surface — visually unifies the "ask o8" affordance everywhere. |

### Adding an Iconoir icon

1. Find the icon name in [iconoir.com](https://iconoir.com) — note the React component name (PascalCase, sometimes renamed: `folder-plus` → `FolderPlus`, `nav-arrow-down` → `NavArrowDown`, `flash` not `zap`).
2. `import { IconName } from 'iconoir-react';` at the top of the consumer file.
3. Render as `<IconName width={size} height={size} color="..." strokeWidth={2} />`. Unlike Lucide/Tabler, Iconoir takes `width`+`height` separately (not `size`).

### Adding a Tabler icon

1. Find the icon name in [tabler.io/icons](https://tabler.io/icons) — note the `Icon*.mjs` filename.
2. Add an `import { __iconNode as XNode } from '@tabler/icons-react/dist/esm/icons/IconX.mjs'` line at the top of `tabler-shims.tsx`.
3. Add `export const X: TablerIcon = makeIcon(XNode as IconNode, 'TablerX');` to the exports.
4. The ambient module declaration in `src/types/tabler-icons-react.d.ts` covers the wildcard subpath import — no per-icon type work needed.

### Comparison surface

`/preview/icons` renders Lucide vs Tabler vs Iconoir side-by-side at 14/18/24 px for 10 common chrome glyphs. Use it when picking the next icon swap. All three columns render as raw SVG (Tauri-compatible).

### Why not just standardize on one set

Lucide is the bulk because most of the 85+ shimmed icons read fine. Switching wholesale to Tabler would force re-deciding every glyph and risks losing the Lucide-trained muscle memory in places where the difference is invisible. Per-glyph picks let us upgrade where it earns its keep.

---

## Design Engineering Tips (motion / interaction)

Reusable interaction techniques every agent should reach for when building a UI surface — adopt the *principle*, implement it framework-idiomatically. **Gate all of these off under `prefers-reduced-motion`, and the cursor ones only on `(hover: hover) and (pointer: fine)`.**

1. **React to cursor VELOCITY, not just position.** A fast move adds a momentary tilt / specular sheen that springs back — physical because it responds to motion. Use the framework's velocity primitive (motion/react `useVelocity → useTransform/useSpring`), never raw `el.style.transform` (it clobbers existing transforms + spikes on pointer re-entry). Always clamp (rotation ≈ ±6°, scale < 1.5×). **Never on text people read** — sheen/tilt only on spectacle surfaces (hero media, floating cards).

2. **React to PROXIMITY, not just hover (the macOS dock).** Nearby items scale + brighten by *distance*, not binary hover. `t = max(0, 1 − dist/RADIUS)` (≈120px), `scale = 1 + t*MAX` (clamp MAX ~0.2 for text). Direct ref writes on `pointermove` are correct here (you touch N elements/frame). On dark themes **brighten, don't darken.** For equal, closely-spaced rows (docks, pill rows) — *not* nav links (hurts click-targeting).

3. **Fade scrollable list EDGES, don't hard-cut.** Content dissolves at top/bottom via `mask-image: linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)` (+ the `-webkit-` twin, `mask-size: 100% 100%`, `mask-repeat: no-repeat`). Only on lists that actually overflow. See **"Mask gradient (scroll fade)"** above for the pinned-header 16/32 variant. Canonical: inline `scrollFadeY` in `src/app/preview/canvas-glass/ui.ts`; the dashboard's `cortex-scroll-fade-y` class (`globals.css`) adds a scroll-timeline dynamic variant that fades only the edge you're scrolled away from.

4. **Reduce backdrop blur while scrolling fast.** Heavy `backdrop-filter` blur during motion kills perceived smoothness + spikes GPU (it re-samples every frame). Scale it via a var multiplier — `blur(calc(var(--frost) * var(--frost-scale, 1)))` — set `--frost-scale ≈ 0.4` on scroll → `1` on settle (debounce ~140ms), **per-surface** (find the `[data-glass-surface]` ancestor), never global, never hardcode the blur value (keep the operator's slider as truth). Invisible at rest — pair with tip 3 for the visible fade. Canonical: `useScrollBlurFade` in `src/app/preview/canvas-glass/use-scroll-blur-fade.ts`.

---

## Canvas card chrome (locked 2026-06-20)

Every floating card on the glass canvas (`/preview/canvas-glass`) — chat, browser, terminal, diff, file, o8.md/spec, brain, agent, markdown, image, video — shares **one** chrome vocabulary. Before this lock each card hand-rolled its own header sizes (titles 8–9.5px, ✕ 7.7px, icons 11–16px) and none matched. Worse: cards live inside the canvas `zoom` layer (the "100%" step is `--cnv-zoom: 0.7`), so an authored `11.5px` title paints at **~8px** on screen — that's why canvas chrome read tiny and "jumbled" even when the numbers looked reasonable.

**The system lives in `src/app/preview/canvas-glass/ui.ts`. Two pieces:**

1. **`CHROME` tokens** — the one size/weight set. Pre-zoom px, tuned so chrome reads ~11–12px on screen at the 100% step, matching the IDE o8.md panel header, the orchestrator dock, and the dock's own ✕:
   - `titleSize: 16` / `titleWeight: 400` — card title (→ 11.2px on screen)
   - `metaSize: 13` / `metaWeight: 300` — secondary meta (branch, W×H, path tail)
   - `iconSize: 18` — header glyph svg (dock, globe, picker, media file icon → 12.6px)
   - `closeSize: 16` — the ✕ glyph (→ 11.2px, ≈ the dock's undock ✕)
   - `fieldSize: 14` — body field text in a header (url bar, tab labels → 9.8px)

2. **`chromeFloorScale(origin)`** — the scaling mechanism. Interactive corner chrome (the ✕ + dock/action cluster) **scales with the canvas like content**, but a clamp lifts it once the field zoom would shrink it below a clickable floor: `scale(clamp(1, calc(var(--cnv-chrome-floor, 0.64) / var(--cnv-zoom, 1)), 1.4))`. At 0.7 it resolves to **1** (pure proportional — no counter-scale); it only boosts when small; 1.4 caps a tiny card from ballooning the buttons. **Text scales freely (no floor); only the interactive buttons floor.** Tune the floor via `--cnv-chrome-floor`.

**Rules:**
- **Never hand-roll a canvas card's chrome sizes.** Route titles/✕/icons through `CHROME`; wrap the ✕/action cluster with `chromeFloorScale(...)`. A new card that sets its own `fontSize: 11.5` reintroduces the jumble.
- **Two render paths, both land at the same on-screen size.** In-layer cards scale via CSS `zoom`; the o8.md/spec card renders *out* of the zoom layer (`screenMap`) and scales its chrome by `* s` (s = zoom) instead — so **gate `chromeFloorScale` off when `screenMap` is set** (it reads `--cnv-zoom` and would double-scale). Both paths render the ✕ at an identical box (verified: 15.4px at 100%).
- **The dock is the 1:1 reference, not a canvas card.** `chrome.tsx` `DockGlyphButton`/`SpawnGlyphButton` and `dock.tsx` render at device 1:1 (outside the zoom layer) — their sizes are the on-screen target the tokens were tuned to match. Don't pull them into the zoom-layer token system. `DockTab` is shared by both the dock (1:1) and the in-layer chat card; it takes an optional `size` (default 14 = dock truth) so the chat card can opt up to `CHROME.titleSize` without touching the dock.
- **Header layout: title/tabs LEFT, actions RIGHT, one row.** The chat card's two tabs (orchestrator title + Cortex) sit left, the title tab truncating via flex `minWidth: 0` + ellipsis (`DockTab truncate`) as the card narrows; the dock+✕ cluster sits **inline** at the right end behind a reserved flex spacer — never absolute in the corner. The old absolute-corner cluster collided with the right tab AND the NE resize zone, and the long title clipped to a bare "...". Shell cards keep a single **centered** title (they carry no second tab) with the cluster top-right; their titles are short enough not to collide.
- **Zoom ladder is 130 / 115 / 100 / 85 / 70** (`--cnv-zoom` 0.91 / 0.805 / 0.7 / 0.595 / 0.49). "100%" = 0.7 is the home/fit anchor: the default state and the loupe **Fit** both resolve the `label === 100` step, **not** `zoomSteps[0]` (which is 130% after the zoom-in steps were prepended). 115/130 let the operator zoom IN — cards + text get bigger, not just smaller. The loupe −/+ step the array monotonically (index 0 = most-in); zoom-out bottoms at 70%.

Shipped in #1259 (commits `0dfc1ab1` tokens+shell+chat, `d464bd53` browser, `3213cd7c` media, `af6a00c9` this spec, `866e4ced` header redesign, `c50d72b7` zoom-IN). Verify after any change in the running app — measure `getBoundingClientRect().height` of each card's ✕ at `--cnv-zoom` 0.49, 0.7, and 0.91; it must match across kinds at each level (15.4px at 100%, 20px at 130%).

---

## Open items for next-level theming

This file captures what got *locked*. The roadmap below is what's *open* — the work that comes next when theme v2 starts from scratch.

1. **Tab-header chat metadata** — when a chat opens in the workspace, the tab header should show chat title + active model + runtime. The sidebar lost its icons because that info should land here instead. Audit existing tab-header surface; either extend it or build new.
2. **Composer-footer model display** — bottom of the composer should always show the current model name (runtime · model · thinking effort). May partially exist via the existing mode chip; verify before adding.
3. **Dark / midnight palette pass** — the locked typography tokens are theme-agnostic by design (only color tokens vary). When the next palette lands, the row hover background and section-label color need vibrancy-aware values.
4. **Status text on `ExtraAgentRowView`** — currently only a colored dot distinguishes `reviewing` from `awaiting_input` from `idle`. Add a small text chip so operators can read state at a glance.
5. **Archived audit** — confirm that "merged + closed" packets reliably land in the `Archived` section under each list (so the operator can verify completion vs missing).
6. **Native specimen pages** — `/preview/typography` is the start of a small design-system surface. Future passes may add palette, density, motion, iconography lab pages under `/preview/*`.

---

## Sidebar float — LOCKED 2026-07-17 (floating inset card, solid surfaces)

Locked 2026-07-17 (supersedes the 2026-07-16 flush dock). In **solid** surfaces the left sidebar is a floating inset card. Glass surfaces keep the transparent-chrome treatment (chrome paints nothing) — this section is solid-only.

- **Float air**: 4px window-backdrop gap on **left, top, and bottom**; 5px on the right (workspace side). The card never touches a window edge.
- **Corners**: 14px radius on **all four** corners.
- **Hairline**: `1px solid var(--t-divider-subtle)` on the card. Load-bearing — card tone ≈ backdrop tone, so the hairline is what makes the float read. Keep the contrast **very faint** — do NOT darken the backdrop or whiten the card to chase stronger separation.
- **One continuous tone**: the header strip (traffic lights + toggle) renders INSIDE the card with `background: transparent` and **no bottom hairline** (`LeftHeaderStrip inCard` prop). No chrome band, no seam — the card is one surface from lights to account row.
- **No drop shadow** (2026-07-13 ruling still applies — elevation on true overlays only).
- Implementation: `dashboard/page.tsx` sidebar column (conditional padding on `effectiveGlassSurface`), `shell/LeftHeaderStrip.tsx` (`inCard`), `shell/ColumnHeaderStrip.tsx` (style spread wins).

---

## ALL GLASS — LOCKED 2026-07-17 (one-material mode, locked by eye)

All Glass is a MODE, not a playground: one recipe, zero user adjusters, permanent (Apple liquid-glass reference). Implementation: `src/lib/theme/context.tsx` WORKSPACE_GLASS_OVERRIDES + the workspace-glass effect.

- **One material**: every in-flow surface transparent (workspace, panels, chrome, canvas, terminal, timeline). Native vibrancy IS the background; text sits directly on glass.
- **Material**: `FullScreenUI` (display-capture bake-off winner — melts the desktop into structureless color; Sheet was flat, per-OS chrome material was grey murk). Asserted on mode entry; per-OS chrome material restored on exit.
- **THE veil** (the one painted thing, window-wide): `linear-gradient(180deg, rgba(10,12,18,0.78) 0%, rgba(10,12,18,0.44) 55%, rgba(10,12,18,0.06) 100%)` — dark where ink lives, opens to bloom at the bottom. **Paints on `body`** — every in-flow div is vibrancy-passthrough (background force-erased `!important`), body is the only surface between the passthrough tree and the material. Red-flash-proven.
- **Faint white breaths** are the only fills: inputs/search/kbd 6%, secondary buttons 7%, glass-elevated 5%, hover/card stay at their 4–5% palette values.
- **Ink is WHITE on the glass** (locked 2026-07-17 — composer text is white in this mode): `--t-chat-surface-text` #fff, `-secondary` white 78%, `-muted` white 62%, `--t-text-muted` white 66%, `--t-text-faint` white 50%. The dark palette's slate inks (#5f6b7a / #8b95a3) read muddy on vibrancy — never let them leak into this mode.
- **Stacked overlays keep dark frost** (`--t-panel-solid` untouched): popovers/menus/drawers sit over app content and CSS backdrop-blur is dead in Tauri — transparent overlays would be text-on-text. This is the deliberate divergence from Apple (their overlays are separate OS windows with real blur).
- **Exit sweep**: overrides apply with inline-`important` (a globals.css `!important` kills the gradient otherwise) and are force-removed BEFORE the target palette repaints on exit — the residue class that broke every other mode on 07-17 must never return.
- **Dev-loop law**: theme-contract edits need a hard reload (HMR does not re-run the theme effect), and never judge glass through window captures (they kill live backdrop sampling — display captures only).

## Composer clusters + "+" switcher — LOCKED 2026-07-17

- **Left cluster = intent**: `+` (attach & mode switcher) · mode chip · mic. **Right cluster = runtime**: context meter · model · thinking · send. Nothing crosses sides.
- **Modes** (the + menu's top section): Solo / Multitask / Mixture of Agents — locked semantics: Solo = the orchestrator dispatches NOTHING (works with its own tools); Multitask = dispatches parallel worker packets; MoA = plans with both frontier models (flips the Collide backend, synced both ways with any other MoA control) then dispatches. Mode = one visible `[Mode: …]` directive line prepended at send; slash commands pass through. Modes persist across sends.
- **Chip**: always visible beside `+`; Solo renders faint (default stays quiet), active modes render accent; click reopens the switcher; title = mode description.
- **Placeholder teaches the mode** — rewritten per mode, no extra chrome.
- **The model picker is models + thinking ONLY** — its Mode section is deleted; never reintroduce intent controls there.
- **Popover recipe** (the locked composer-menu style): 240px drawer, flat single-line rows 26px (radius 7, 12.5px label, check right), ONE faint caption line (fixed height, hover-follows) instead of per-row sublabels, flat rows for actions — never bordered input-bubbles.

## Free theme trio — LOCKED 2026-07-17 (ships with free/OSS)

Light / Dark / Glass mean the SAME thing on both surfaces (IDE + Canvas).

- **Light** = cream paper, dark ink (IDE light-solid ↔ canvas Paper-light).
- **Dark** = opaque graphite (IDE dark-solid ↔ canvas free Dark: veil 0.95 window material — NOT the old translucent 0.3 that read as a second glass).
- **Glass** = the All Glass recipe (IDE mode ↔ canvas `glass` preset: fullscreen material, veil 0.45 flat-wash translation, tint 0.10). Free Glass has no adjusters — it IS the locked mode. Boot clamp maps stored settings via `canvasFreeLookIdFor` so free Glass survives relaunch.

---

## Why this file exists

Locked starting 2026-05-25, after the chat-row typography pass, to hold the values theme v2 must respect.

This is the seed. When theme v2 begins, the rule is: **respect every locked value above, then layer new tokens around them.** Don't re-dial without the operator visually confirming.
