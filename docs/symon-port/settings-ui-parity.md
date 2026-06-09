# Symon → o8 — Settings UI Parity Spec

**Problem (from the screenshot):** o8 shipped Settings as **one scrolling "o8 Voice Settings" page** — a `VOICE` header (red dot) over `FEEDBACK` toggles → `POLISH` (dictionary + instructions) → `HISTORY`, all stacked in a plain dark panel. **That is not how Symon's settings looks.**

**Symon's settings is a borderless, transparent, rounded glass WINDOW with a 188px left sidebar + 8–10 tabbed pages**, each page a set of glass "section cards" built from a shared component system. o8 collapsed ~4 of those tabs into one page and dropped the rest + the whole shell.

This spec gives the exact shell, the shared visual primitives (port once), the tab map, and what to move where. Source: `~/aqua-color/src/SettingsApp.svelte` (shell) + `src/lib/settings/*` (pages). o8 rule: inline styles only — values below are the contract.

---

## 1. The architecture fix (do this first)

Symon settings = **window shell (sidebar + content) → tabbed pages → section cards → rows**. Rebuild around that, then fill pages. Map o8's current single page onto Symon's tabs:

| o8 today (one page) | → Symon home |
|---|---|
| `VOICE` red-dot header | ❌ remove — there's no per-page colored-dot header; the **sidebar** carries the brand; each page leads with a plain `.page-title` ("Settings", "History", …) |
| `FEEDBACK`: Dim other audio, Sound cues | → the **Settings** tab (these are o8 additions; fold them into the main Settings page sections, styled as `setting-row--toggle`) |
| `POLISH`: Custom dictionary | → the **Dictionary** tab (chip list, its own page) |
| `POLISH`: Polish instructions | → the **Instructions** tab (textarea, its own page) |
| `HISTORY`: inline list | → the **History** tab (full transcript list w/ replay/rerun) |
| *(missing)* | **Settings, Snippets, Stats, Account, Report Issue** tabs + founder **Founder, Agent Beta** |

So: the o8 page is roughly *Dictionary + Instructions + History + two stray toggles* mashed together, missing the main Settings controls and 5–7 other tabs.

---

## 2. Window shell (`SettingsApp.svelte`)

**Native window:** label `settings`, **660×720** (min 520×560), `resizable:true`, **`decorations:false`, `transparent:true`, `shadow:false`, `alwaysOnTop:false`, centered, `visible:false` until ready. o8 currently shows a **decorated** window titled "o8 Voice Settings" — drop the native title bar; Symon draws its own chrome and rounds the whole panel to **22px**.

**Layout:** `display:flex` — `.sidebar` (188px, fixed) + `.content` (flex:1, scroll). Whole window:
```
border-radius: 22px; overflow: hidden; border: 1px solid var(--settings-shell-border);
background:
  radial-gradient(circle at top left, color-mix(in srgb, var(--accent-glow) 28%, transparent), transparent 38%),
  var(--settings-shell-bg);
backdrop-filter: blur(calc(var(--glass-blur) + 4px)) saturate(1.08);
box-shadow: var(--settings-shell-shadow);
```
Plus a `::before` full-bleed frost layer (`var(--settings-frost-base)`, blur+6). `--glass-blur` = 24px (tokens).

### Sidebar (188px) — `SettingsApp.svelte:281`
- **Top: traffic lights** drawn in-app (`padding:12px 14px 0`, `gap:8`). Three 12px circles: close `#FF5F57` (hover `#FF3B30`, **the only clickable one** → `window.hide()`), minimize `#FFBD2E`, zoom `#28CA41`. The header div is a **drag region** (`startDragging()` on mousedown).
- **Brand block** (`:332`, column, center, `gap:6`, `padding:24px 18px 18px`, bottom border): the BrandGlyph, then `brand-name` = product name **uppercase, 11px / weight 700 / letter-spacing 0.18em**, `brand-version` "v{x}" 10px tertiary, then a **96×16 brand wave** SVG stroked with the gradient `#88D1F1→#B1B4E5→#F5B8C4→#F4C977`. Also a drag region.
- **Nav** (`:388`, column, `gap:2`, `padding:8`): one `.nav-item` per tab — `flex; gap:10; padding:10px 12px; border-radius:12px; font:13px/500; color:var(--text-secondary)`; **icon 18px (Phosphor), `weight="fill"` when active else `regular`**. Hover: `bg var(--settings-nav-hover)` + `translateY(-1px)` + primary text. Active: `bg var(--settings-nav-active)` + 1px border + `inset 0 1px 0 rgba(255,255,255,0.12)`.

### Content (`:437`)
`flex:1; padding:0 28px 28px; overflow-y:auto;` with a **dotted-grid background**:
```
background:
  radial-gradient(circle at 1px 1px, var(--settings-grid-dot) 1px, transparent 0) 0 0 / 22px 22px,
  var(--settings-content-bg);
```
First child is a **46px drag bar** (`.content__drag-bar`, `cursor:grab`). Then the active page (lazy-loaded). Tabs are code-split and `import()`-ed on first select; History is idle-prefetched.

### Tabs (`SettingsApp.svelte:25,44-53,153-160`)
Base order + Phosphor icon: **Settings** (Gear) · **Dictionary** (BookOpen) · **Snippets** (ArrowsLeftRight) · **Instructions** (NotePencil) · **History** (ClockCounterClockwise) · **Stats** (ChartBar) · **Account** (User) · **Report Issue** (Warning). When `founder_edition_enabled==='true'`, insert **Founder** (Crown) + **Agent Beta** (Robot) immediately before Report Issue.

### Light/dark theming — `settingsSurfaceStyle(surface)` (`:75-114`)
The window reads the selected **pill surface** (pref `pill_surface`, default `apple-glass`) and sets `data-settings-tone` + a big block of CSS vars. **`frost` = light theme; everything else = dark.** Port this var map verbatim (it's what makes the window feel like Symon, not a generic dark panel):

| var | light (`frost`) | dark (default) |
|---|---|---|
| `--settings-shell-bg` | `linear-gradient(180deg, rgba(255,255,255,.92), rgba(255,255,255,.78))` | `linear-gradient(180deg, rgba(10,16,26,.88), rgba(9,14,24,.78))` |
| `--settings-frost-base` | `…rgba(255,255,255,.86)→.68` | `…rgba(10,16,26,.72)→rgba(9,14,24,.62)` |
| `--settings-shell-border` | `rgba(255,255,255,.84)` | `rgba(255,255,255,.12)` |
| `--settings-shell-shadow` | `0 24px 60px rgba(148,163,184,.18)` | `0 24px 60px rgba(2,6,23,.34)` |
| `--settings-sidebar-bg` | `…rgba(255,255,255,.68)→.44` | `…rgba(255,255,255,.09)→.04` |
| `--settings-content-bg` | `…rgba(255,255,255,.42)→.24` | `…rgba(255,255,255,.05)→.02` |
| `--settings-grid-dot` | `rgba(15,23,42,.08)` | `rgba(255,255,255,.08)` |
| `--settings-nav-hover` | `rgba(255,255,255,.68)` | `rgba(255,255,255,.09)` |
| `--settings-nav-active` | `rgba(255,255,255,.86)` | `rgba(255,255,255,.14)` |
| `--settings-section-bg` | `…rgba(255,255,255,.74)→.52` | `…rgba(255,255,255,.065)→.025` |
| `--settings-section-border` | `rgba(15,23,42,.08)` | `rgba(255,255,255,.08)` |
| `--settings-section-shadow` | `0 14px 34px rgba(148,163,184,.12)` | `0 18px 36px rgba(2,6,23,.16)` |
| `--glass-bg / -hover / -active` | `.62 / .78 / .9` white | `.06 / .10 / .14` white |
| `--glass-border / -subtle` | `rgba(15,23,42,.1) / .08` | `rgba(255,255,255,.14) / .08` |
| `--text-primary/secondary/tertiary` | from surface | from surface |

It re-applies live on the `pill-surface-changed` event.

---

## 3. Shared visual primitives (port once, reuse on every page)

These classes (`SettingsPage.svelte` `<style>` `:1358+`) are the design system. Build them as reusable React components/inline-style helpers; **every page is just these stacked.**

**Page title** — each page leads with one: `font-size:22px; font-weight:560; letter-spacing:-0.03em; color:var(--text-primary)`.

**Section card** `.settings-section`: `padding:16px 18px; border-radius:18px; border:1px solid var(--settings-section-border); background:var(--settings-section-bg); box-shadow:var(--settings-section-shadow); backdrop-filter:blur(calc(var(--glass-blur)*0.5))`.

**Section header** `.section-title`: `flex; gap:6px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.14em; color:var(--text-secondary); margin-bottom:10px` — leading **icon in `var(--accent)`** (13px Phosphor `fill`). Collapsible variant adds a right-aligned `›` chevron (`rotate(90deg)` when open) + an optional green status pill ("ALL GRANTED"). Sub-copy `.section-hint`: `12px; color:var(--text-tertiary); line-height:1.5`.

**Row** `.setting-row`: `flex; justify-content:space-between; align-items:center; padding:9px 0; border-bottom:1px solid var(--glass-border-subtle)` (last child none). Variants: `--toggle` (`align-items:flex-start; gap:12`), `--stacked` (`flex-direction:column; align-items:stretch; gap:10`), `--stackable` (`align-items:flex-start; gap:16`). Left side: `.setting-label` (13px primary) optionally over `.setting-description` (12px tertiary) in a `.setting-label-group`.

**Toggle** `.toggle` (the iOS switch): `width:44px; height:24px; border-radius:12px; background:var(--glass-border)`; on = `background:var(--accent)`. Knob: `20×20; border-radius:50%; background:white; top:2; left:2; box-shadow:0 1px 3px rgba(0,0,0,.2)`; on → `transform:translateX(20px)`; `transition:200ms`. (o8's screenshot uses a blue toggle already — match these exact dims + accent `#4058FF`.)

**Select** `.setting-select`: `min-width:220px; height:32px; padding:0 10px; border-radius:8px; border:1px solid var(--glass-border-subtle); background:var(--glass-bg); font-size:12px`; focus → `border:var(--accent)` + `box-shadow:0 0 0 2px var(--accent-glow)`. (`--compact` = full width; `--wide` = 260–340.)

**Segmented control** `.segmented-control` (e.g. Tone): `inline-grid; grid-auto-flow:column; gap:2; min-height:32px; padding:3px; border-radius:8px; border + var(--glass-bg)`. Buttons `min-width:58px; height:24px; border-radius:6px; font-size:11px; color:tertiary`; active → `color:primary; background:color-mix(in srgb, var(--accent) 16%, transparent); box-shadow:inset 0 0 0 1px color-mix(var(--accent) 30%)`.

**Slider** `.speed-slider`: `width:120px; height:4px; border-radius:2px; background:var(--glass-border)`; thumb `14×14; border-radius:50%; background:var(--accent); box-shadow:0 0 6px var(--accent-glow)`.

**Status badge** `.status-badge` (`12px` + 7px dot): ok = `#34D399` (glow); warn = `#F59E0B`. **Pro pill** `.pro-pill`: sky-tinted, `9px/700` uppercase, `border rgba(125,211,252,.45)`, used next to Pro-gated labels.

**Surface picker** `.pill-surface-grid` (`auto-fit minmax(160px,1fr)`): each `.pill-surface-card` (radius 12) has a 38px pill `__preview` painted with `var(--pill-surface-bg)`; active = accent ring `box-shadow:0 0 0 1px rgba(90,132,255,.2)`.

**Permission card / banner / step** (`:1465-1835`): 2-col `.permission-grid`; `.permission-step` numbered chips (done = green tint); `.permission-banner` (ok green / warn amber / restart blue) with 28px icon + copy. Buttons `.permission-btn` (34px, glass) / `--accent` (blue tint).

---

## 4. Per-tab inventory (build these pages)

Controls → prefs/commands are detailed in the **master dossier Part 6** (`o8-symon-parity-dossier.md`); summary of what each tab renders:

1. **Settings** (`SettingsPage.svelte`) — the main page, 5 section cards:
   - **Input** (Microphone icon): mic `<select>` (`dictation_microphone_uid`), "High-accuracy dictation" toggle (`whisper_stt_enabled`, default ON), Dictation Language `<select>` (`dictation_locale`), Tone segmented control (`output_tone`).
   - **Appearance** (Desktop icon, hint "Choose how Symon looks while it listens, thinks, and speaks."): pill **surface grid** (`pill_surface`), "Allow moving the pill" toggle (`pill_movement_enabled`), "Dock to top notch" toggle (`surface_anchor`), "Show idle capsule at notch" toggle (`notch_idle_pill`, default ON), "Launch at login" (`autostart_enabled`), "Show waveform while holding Fn" (`listening_show_waveform`).
   - **Permissions** (Eye icon, collapsible, status pill "All granted"): the permission grid (mic / speech / accessibility / screen recording) via `get_permission_statuses` + guided setup.
   - **Voice Output** (SpeakerHigh icon, Pro-gated): "Symon voice" toggle (`symon_voice_enabled`), "Ask answer voice" `<select>` (`symon_voice_id`), "Read aloud voice" `<select>` (`tts_voice_id`), Reading Speed slider 0.5–2.0 (`reading_speed`). Provider/model pickers here are **founder-only** (non-founders pinned to openrouter).
   - **Advanced Context** (founder-only): "Let Symon see recent repos" (`workspace_context_enabled`), "Allow cursor warp" (`agent_can_warp_cursor`).
2. **Dictionary** (`DictionaryPage.svelte`) — chip list of custom words → `dictionary` (JSON `string[]`). (o8's "Custom dictionary" textarea → make this a real chip/tag list page.)
3. **Snippets** (`ReplacementsPage.svelte`) — `{trigger → replacement}` rows, add/delete → `replacements`.
4. **Instructions** (`InstructionsPage.svelte`) — single freeform textarea + Save → `instructions`. (o8's "Polish instructions" → its own tab.)
5. **History** (`HistoryPage.svelte`) — transcript list (newest first), replay audio, re-run polish; commands `get_transcripts`/`get_transcript`/`replay_transcript_audio`/`rerun_transcript`/`paste_last_transcript`.
6. **Stats** (`StatsPage.svelte`) — read-only dashboard: total words, sessions, today, day streak, top app, avg WPM, time saved, level + progress (`get_stats`→`StatsSnapshot`).
7. **Account** (`AccountPage.svelte` + `AccountSignInCard.svelte`) — sign-in card (Stripe checkout / magic-link), software update, founder-only Runtime/Diagnostics. (License/proxy flow = master dossier §6.3.)
8. **Report Issue** (`ReportIssuePage.svelte`) — diagnostics + report → `get_feedback_context`/`submit_feedback`.
9. **Founder** (founder, `FounderPage.svelte`) — ElevenLabs personal-voice config + voice library (master dossier Part 5).
10. **Agent Beta** (founder, `AgentPage.svelte`) — quota bar, safety toggles, allowed-actions reference.

---

## 5. Port notes & checklist

- [ ] **Borderless transparent window**, 660×720, 22px radius, custom in-sidebar traffic lights (close → hide), draggable header + brand + 46px content drag-bar. Kill the native "o8 Voice Settings" title bar.
- [ ] **188px sidebar** with BrandGlyph + uppercase brand (11px/700/0.18em) + version + brand-wave, then the tabbed nav (Phosphor icons, fill when active).
- [ ] **Lazy-load** each tab; idle-prefetch History.
- [ ] Port the **`settingsSurfaceStyle` var map** + `data-settings-tone`; read `pill_surface`, react to `pill-surface-changed`. `frost`=light, else dark.
- [ ] Build the **shared primitives** (§3) once: page-title, section card, section-title (+collapsible), section-hint, setting-row (+toggle/stacked/stackable), toggle, select, segmented, slider, status-badge, pro-pill, surface-grid, permission card/banner.
- [ ] Build the **10 pages** (§4); founder-gate Founder + Agent Beta + the provider/model pickers + Advanced Context behind `founder_edition_enabled`.
- [ ] Replicate the Settings-mount **migrations** (`tts_provider edge→google`, `→pro`, force `pill_style=wave_bar` / `local_agent_enabled=false`) and the `load_preference`/`save_preference` contract (returns `""` absent; booleans are `'true'`/`'false'` strings).
- [ ] Move o8's current page contents to their real homes (Dictionary tab, Instructions tab, History tab); the two "Feedback" toggles fold into the Settings page as `setting-row--toggle`s.

**Source files:** shell `src/SettingsApp.svelte`; primitives + main page `src/lib/settings/SettingsPage.svelte` (`<style>` `:1358-2182`); pages `src/lib/settings/{Dictionary,Replacements,Instructions,History,Stats,Account,AccountSignInCard,ReportIssue,Founder,Agent}Page.svelte`; tokens `src/lib/styles/tokens.css`; surfaces `src/lib/pillSurfaces.ts`.
