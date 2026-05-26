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

## Typography tokens (locked)

| Role | Size | Weight | Letter-spacing | Line-height | Notes |
|---|---|---|---|---|---|
| **Row title** (chat row, agent row, packet row) | 13.5 px | **300** | **−0.1 px** | **1.25** | Light weight is load-bearing — drops the visual noise that a 400-weight body would carry. |
| **Row meta** (subtitle under title) | 9.5 px | **260** | **−0.4 px** | **1.25** | Very thin, very tight. Reads as a soft second-tier label, not as competing content. |
| **Section label** (Open now / Archived / Spawned agents / per-repo) | 10 px | **300** | **−0.1 px** | 14 px | NO uppercase, NO bold. Soft gray (`var(--t-text-faint)`). |
| **Computed CSS spec** for sliders → code | see below | | | | The lab's "Computed CSS" pane is the source of truth. |

The numbers above are not negotiable for the chat-row pattern. They came out of a long visual tuning session against a Claude desktop reference, then got committed across every list surface in [`src/components/desktop/`](src/components/desktop/).

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

All section/group labels render at `paddingLeft: 14`. That includes `SectionLabel` ("Open now" / "Archived"), `RepoGroupLabel` (per-repo "cortex-ide"), and `GroupHeader` ("Spawned agents", per-repo subhead). Row text uses `paddingLeft: compact ? 10 : 12` — a 2–4 px tighter indent than the labels above them. This creates the soft hierarchy: labels sit slightly indented from row content rather than the reverse.

---

## Layout primitives

| Token | Value | Where |
|---|---|---|
| Row vertical padding | 5 px top + 5 px bottom | All chat / agent / packet rows |
| Row gap between rows | 0 px | Separators removed — rows touch, hover background is the only inter-row affordance |
| Section label paddingLeft | 14 px | Aligns `Open now` / `Archived` / per-repo headers / `Spawned agents` |
| Row paddingLeft | 10 (compact) / 12 px | Row text indents tighter than labels above |
| Row paddingRight | 10 (compact) / 12 px | Symmetric |

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

## Open items for next-level theming

This file captures what got *locked*. The roadmap below is what's *open* — the work that comes next when theme v2 starts from scratch.

1. **Tab-header chat metadata** — when a chat opens in the workspace, the tab header should show chat title + active model + runtime. The sidebar lost its icons because that info should land here instead. Audit existing tab-header surface; either extend it or build new.
2. **Composer-footer model display** — bottom of the composer should always show the current model name (e.g., "Claude Code · Extra High" or "Codex 5.5 · xhigh"). May partially exist via the existing mode chip; verify before adding.
3. **Dark / midnight palette pass** — the locked typography tokens are theme-agnostic by design (only color tokens vary). When the next palette lands, the row hover background and section-label color need vibrancy-aware values.
4. **Status text on `ExtraAgentRowView`** — currently only a colored dot distinguishes `reviewing` from `awaiting_input` from `idle`. Add a small text chip so operators can read state at a glance.
5. **Archived audit** — confirm that "merged + closed" packets reliably land in the `Archived` section under each list (so the operator can verify completion vs missing).
6. **Native specimen pages** — `/preview/typography` is the start of a small design-system surface. Future passes may add palette, density, motion, iconography lab pages under `/preview/*`.

---

## Why this file exists

The operator asked for it on 2026-05-25 after dialing in the chat-row typography pass: *"we need to lock this style and font in to a new style sheet we will build from scratch later on … hold valuable information about the next level of theming."*

This is the seed. When theme v2 begins, the rule is: **respect every locked value above, then layer new tokens around them.** Don't re-dial without the operator visually confirming.
