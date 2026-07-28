# Motion & Animation Audit — o8 desktop (2026-07-12)

- **Commit**: a5e5b2fd
- **Method**: `improve-animations` skill — recon → 5 parallel read-only area audits → every finding re-verified at its `file:line` by the author before it appears here. Rule catalog: `~/.claude/skills/improve-animations/AUDIT.md` (Emil Kowalski's motion philosophy).
- **Scope**: `src/components/desktop/**` + `src/app/globals.css`. Mobile (`src/components/mobile/**`) untouched by design.
- **Read-only**: no source was modified. Each plan below is self-contained for a worker agent with zero other context.

## o8 constraints every plan respects

- **Compositor-only (operator-locked 2026-07-12)**: animate `transform`/`opacity` ONLY. Any animation of a paint property (`background-position`, `background`, `filter`, `box-shadow`, looped `color`/`border-color`) is auto-rejected. A 7px dot animating `background-position` cost 9.5% idle CPU; a framer `blur()` transition re-ran a full-screen gaussian. Both were removed. This audit extends that ruling.
- **Status-dot families are LOCKED**: `.o8-fam.*` (Drift/Breathe/Hold-blink/Gravity/Settle) and `.o8-rev-*` in `globals.css`. Not audited, not touched. Nothing below proposes changing them.
- **Sanctioned pattern**: React inline styles for layout; CSS `@keyframes` in `globals.css` referenced by `className`. That is correct, not a finding.
- **House curve**: `cubic-bezier(0.22, 1, 0.36, 1)` — hand-typed **362×**, no CSS variable. **House spring**: framer-motion `stiffness:400 damping:30`.
- **Perf floor**: Intel i7 / WKWebView. Reduced-motion support must be preserved and extended.

## Recon summary

- **48 `@keyframes`** in `globals.css`; ~26 desktop files import framer-motion (v12.36).
- **No `--ease-*` / `--duration-*` / spring tokens exist.** The house curve is inlined 362×; springs have drifted into near-duplicates (stiffness 360/380/400/420, damping 28/30/32).
- **`transition: all` appears 23×** in desktop components (AUDIT §5: always a finding — animates unintended props off-GPU).
- **Reduced-motion** covers only the loader family + a few dot shimmers (`globals.css:2221`). ~10 non-locked infinite loops keep moving under `prefers-reduced-motion: reduce`.
- The corrective work dominates; genuine *missing* motion is limited (§ Missed opportunities). The high-emotion beats (onboarding, lightbox, empty states) already spend their delight budget correctly.

---

## Prioritized findings — ordered by what the operator FEELS first

| # | Sev | Cat | Location | Finding | Fix |
|---|-----|-----|----------|---------|-----|
| 1 | HIGH | 5 | `globals.css:1819` `o8-text-shimmer` (live via `repo-focus/tabs/control-room/helpers.ts:255`, `chats/helpers.ts:23`) | Infinite loop animates `background-position: 200%→-200%` on a `background-clip:text` gradient → WebKit re-rasterizes clipped text every frame, on active task/chat rows | Replace with `transform: translateX` sheen or opacity pulse. Also delete dead paint-loop keyframes `pillBreathe` (1562, `box-shadow`) and `sessionPulse` (1797, `border-color`+`box-shadow`) — **zero consumers**. |
| 2 | HIGH | 5 | `globals.css:1633` `.cortex-scroll-fade-y` on the streaming scroller `thoughts/chat-panel/ChatMessageList.tsx:139` (also `AgentPanel.tsx:337`, `CollideProposalCard.tsx:201`) | `mask-image` sits on the `overflowY:auto` element that streams text → the mask re-composites on every repaint as tokens arrive, on the most-watched surface | Move the fade to two static sibling overlay gradient `<div>`s outside the scroll flow. |
| 3 | HIGH | 5 | `workspace-terminal/SessionTileSurface.tsx:134` | Tile split/merge morph transitions `left, top, width, height` (220ms) — pure layout+paint, off-GPU, drops frames on multi-tile rearrange | Drive position/size with `transform: translate()/scale()`; keep the percentage rect as the resting layout. |
| 4 | MED | 5 | 23× incl. `Canvas.tsx:275`, `WorkspaceChatPane.tsx:530` | `transition: 'all …'` animates every changed prop (incl. `box-shadow`, layout) off-GPU | Enumerate the actual properties (`transform`, `opacity`, `background`, `color`). |
| 5 | MED | 5 | `slide-in-preview` `globals.css:1549` (used `WorkspaceTerminalRoot.tsx:281`); `AnalyticsPage.tsx:400`; `Onboarding.tsx:116`; `compactPulse` `globals.css:1566`; `DictationPill.tsx:596` | Animate `max-height`/`width` (layout every frame) | `transform: scaleX/scaleY` with `transform-origin`, or `clip-path: inset()`. |
| 6 | MED | 6 | `globals.css:2221` (block) | ~10 non-locked infinite loops (`spin`, `pulse-dot`, `timelineNowPulse`, `blink`, `o8-sweep-circle`, `tab-label-shimmer`, `o8ToolChipPulse`, `alert-bell-shake`, `compactPulse`, inline `o8-text-shimmer`) are NOT frozen under `prefers-reduced-motion` | Extend the reduce block to freeze them to a legible resting frame. |
| 7 | MED | 7 | codebase-wide | House curve inlined 362×; springs drifting; no motion tokens | Define `--ease-out`, `--dur-*` in `globals.css` and a shared spring preset; adopt incrementally. |
| 8 | MED | 2 | `WorkspaceChatPane.tsx:213,410,462,531`; `ChatSurface.tsx:191` | `llmFadeIn 400ms` message/list entrances exceed the <300ms UI budget | Cut to 220–250ms. |
| 9 | MED | 5 | `dictation/DictationPill.tsx:231` | EQ canvas transitions `filter: saturate/brightness` (180ms) on every voice toggle | Drop the `filter` transition; bake saturation into the canvas gradient or cross-fade opacity layers. |
| 10 | MED | 1 | `CommandPalette.tsx:531` | ⌘⇧K palette card animates `scale:0.96 + y:-6` spring — a 100+/day keyboard action (AUDIT §1: no animation; Raycast has none). Sibling `QuickActionPalette` correctly teleports | Keep the 0.12s overlay opacity fade; drop the card scale/slide (or reduce to opacity-only). |
| 11 | MED | 4 | `workspace-terminal/FleetCanvasTab.tsx:144` | Free-drag clamps at boundary with a hard stop; release commits raw coords with no spring/velocity settle | Rubber-band (rising friction) past edges; spring the release. Also `291`: `scale/opacity` loop uses framer shorthand + no reduced-motion. |

### Missed opportunities (additive — teleports that should transition)

- **`O8Panel.tsx:729`** — right-panel tabs swap via `display:'flex'/'none'`; content teleports on every tab switch. A 120–150ms opacity crossfade on active-tab change would connect the panels spatially. (§8)
- **`orchestrator/ToolCallChipCluster.tsx:185`** — "+N more" / "Collapse" is a bare conditional render; chips pop in/out with no transition; the `selectedTool` detail dialog (`:278`) teleports open under the cluster. (§8)
- **`thoughts/chat-panel/ChatToastStack.tsx:33`** (+ `ClearToast`) — clear-thread / draft-cleared / reload toasts mount & unmount with no `AnimatePresence`; abrupt appear, no exit. (§8)
- **Portal popovers** `PacketDetailsPopover.tsx:171`, `ComposerPopover.tsx:103`, `ModelPicker.tsx:94` — anchored to a trigger but enter with no origin cue (or `transform-origin` not set to the trigger). Adding `transform-origin` + `scale(0.96)`+opacity enter explains where they came from. `SessionPillContextMenu.tsx:100` already does this correctly — copy it. (§3/§8)

### Verified clean (no action — recorded so they are not re-flagged)

Title-bar / shell pill buttons (`TitleBarButton`, `SidebarTogglePill`, `HeaderIconPill`, `BrowserHoverButton`, `RightPanelMorphButton`) — all house curve ≤200ms, transform/opacity only, icon swaps use `scale(0.72–0.85)` not `scale(0)`. `ArtifactLightbox.tsx:71`, `OnboardingOpen.tsx:60`, `TimelineEmptyState.tsx:28`, `Canvas.tsx:317` — correct springs, `scale` 0.94–0.99 (never 0), delight budget well spent. `status-bar-icons.tsx` bell — single spring lean, not a loop. `tab-label-shimmer` keyframe — pure opacity (only its reduced-motion gap counts, #6). No `ease-in` on any non-locked UI. No framer `x/y` shorthand on hot elements outside FleetCanvasTab.

---

# Plans

Each plan is independent unless a dependency is noted. Recommended order and dependencies are in the table at the bottom.

---

## 001 — Kill the live paint-loop shimmer; delete two dead paint-loop keyframes

- **Status**: DONE 2026-07-27
- **Commit**: a5e5b2fd
- **Severity**: HIGH
- **Category**: 5 (Performance)
- **Estimated scope**: `globals.css` + 2 helper files, ~40 lines

### Problem

`o8-text-shimmer` animates a paint property on an infinite loop — the exact class the 2026-07-12 compositor lock exists to kill:

```css
/* src/app/globals.css:1819 — current */
@keyframes o8-text-shimmer {
  0%   { background-position: 200% center; }
  100% { background-position: -200% center; }
}
```

It is applied **inline** (so it also dodges the reduced-motion block in plan 006):

```ts
// src/components/desktop/repo-focus/tabs/control-room/helpers.ts:247 — current
export function shimmerTextStyle(base = 'var(--t-text)', flare = 'var(--t-accent)'): CSSProperties {
  return {
    // ... background-clip:text gradient ...
    animation: 'o8-text-shimmer 2.35s linear infinite',
  };
}
// Duplicate: src/components/desktop/repo-focus/tabs/chats/helpers.ts:15 (same body, :23 animation line)
```

It runs on the **active** task/chat row (`TaskRow.tsx:120`, `HistoryRows.tsx:295`, `AgentPanelExtraAgentRow.tsx:188`) — i.e. constantly, on a `background-clip:text` gradient WebKit must re-rasterize every frame.

Two more keyframes animate paint on an infinite loop but have **zero consumers** (`grep -rn 'pillBreathe\|sessionPulse' src` → only globals.css) — dead code that invites future misuse:

```css
/* src/app/globals.css:1562 — dead */
@keyframes pillBreathe {
  0%,100% { box-shadow: 0 0 0 1px rgba(0,122,255,0.1), 0 0 12px rgba(0,122,255,0.12); }
  50%     { box-shadow: 0 0 0 2px rgba(0,122,255,0.18), 0 0 20px rgba(0,122,255,0.2); }
}
/* src/app/globals.css:1797 — dead */
@keyframes sessionPulse {
  0%,100% { border-color: rgba(52,211,153,0.25); box-shadow: 0 0 12px rgba(52,211,153,0.08), inset 0 0 8px rgba(52,211,153,0.03); }
  50%     { border-color: rgba(52,211,153,0.08); box-shadow: 0 0 4px rgba(52,211,153,0.02),  inset 0 0 4px rgba(52,211,153,0.01); }
}
```

### Target

Replace the shimmer's *motion* with an opacity pulse (identical visual intent — "lock the eye onto the active row" — the existing comment says the effect is meant to read as a pulse). Opacity is compositor-safe:

```css
/* target — src/app/globals.css, replacing the o8-text-shimmer keyframe */
@keyframes o8-text-shimmer {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
```

And drop the `background-position` machinery in `shimmerTextStyle` — the gradient/`background-clip:text` can stay as a static flare, but the animation must not move `background-position`. Simplest correct form: keep the static gradient fill, animate opacity:

```ts
// target — both helpers.ts files (control-room:247, chats:15)
export function shimmerTextStyle(base = 'var(--t-text)', flare = 'var(--t-accent)'): CSSProperties {
  return {
    color: base,
    // keep a static gradient flare if desired, but NO backgroundSize:'200%' / backgroundPosition
    animation: 'o8-text-shimmer 2.35s ease-in-out infinite',
  };
}
```

Delete `pillBreathe` and `sessionPulse` keyframes entirely.

### Repo conventions to follow

- Exemplar of a correct opacity-pulse "shimmer" already in this file: `tab-label-shimmer` (`globals.css:1814`) — `0%,100%{opacity:1} 50%{opacity:0.45}`. Match that shape.
- Both `helpers.ts` files are byte-identical copies; change both.

### Steps

1. `globals.css:1819` — replace the `o8-text-shimmer` keyframe body with the opacity form above.
2. `control-room/helpers.ts:247` and `chats/helpers.ts:15` — in `shimmerTextStyle`, remove any `backgroundSize`/`backgroundPosition` (and `WebkitBackgroundClip:'text'` transparent-fill IF it only existed to carry the moving gradient — keep it only if a static flare is still wanted). Change the `animation` timing function to `ease-in-out`. Confirm the two files stay identical.
3. `globals.css:1562` and `globals.css:1797` — delete the `pillBreathe` and `sessionPulse` keyframe blocks.

### Boundaries

- Do NOT touch `.o8-fam.*` or `.o8-rev-*`.
- Do NOT change which rows call `shimmerTextStyle` — motion only.
- If `pillBreathe`/`sessionPulse` have gained a consumer since commit `a5e5b2fd` (re-grep), STOP — do not delete a live keyframe; report instead.

### Verification

- **Mechanical**: `npx tsc --noEmit` clean. `grep -rn 'background-position' src/app/globals.css src/components/desktop` returns nothing that loops (the sweep-circle mask is fine — it uses transform).
- **Feel check**: run the app, focus a repo so an "Orchestrator"/active row shimmers. In DevTools Performance, record 3s idle with the row visible — CPU should sit near-flat (no per-frame raster of the text). The row should pulse in brightness, not slide a highlight.
- **Done when**: no non-locked `@keyframes` animates a paint property; the active-row cue still reads as a pulse.

---

## 002 — Move the streaming-transcript scroll fade off the scroller

- **Status**: TODO
- **Commit**: a5e5b2fd
- **Severity**: HIGH
- **Category**: 5 (Performance)
- **Estimated scope**: 1 CSS rule + ~3 call sites, medium

### Problem

The top/bottom fade on the orchestrator transcript is a `mask-image` painted **onto the scrolling element itself** — the element whose text streams token-by-token:

```tsx
// src/components/desktop/thoughts/chat-panel/ChatMessageList.tsx:139 — current
<div
  className="thoughts-scroll cortex-scroll-fade-y cortex-themed-scroll"
  style={{ flex: 1, overflowY: 'auto', /* … */ }}
>
```

```css
/* src/app/globals.css:1633 — current (mask lives on the scroll/stream element) */
.scroll-fade-y,
.cortex-terminal-fade .xterm-viewport {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--cortex-scroll-fade-top), #000 calc(100% - var(--cortex-scroll-fade-bottom)), transparent 100%);
  mask-image: /* same */;
}
```

Every time a streamed token mutates the scroller's contents, WebKit re-applies the mask over the whole element. Same pattern at `AgentPanel.tsx:337` and `CollideProposalCard.tsx:201` (a `maxHeight:220` `overflowY:auto` card).

### Target

Keep the exact same visual fade, but paint it with two **static, non-scrolling** gradient overlay siblings positioned over the top and bottom edges of the scroll container — so the mask never re-composites with streamed content. The scroll container becomes a plain `overflow:auto` with no mask.

```tsx
/* target — wrap the scroller */
<div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
  <div className="thoughts-scroll cortex-themed-scroll" style={{ position:'absolute', inset:0, overflowY:'auto' }}> … messages … </div>
  {/* static edge overlays — pointer-events:none, do not scroll */}
  <div aria-hidden style={{ position:'absolute', top:0, left:0, right:0, height:24, pointerEvents:'none',
        background:'linear-gradient(to bottom, var(--t-chat-surface-bg), transparent)' }} />
  <div aria-hidden style={{ position:'absolute', bottom:0, left:0, right:0, height:32, pointerEvents:'none',
        background:'linear-gradient(to top, var(--t-chat-surface-bg), transparent)' }} />
</div>
```

Use the theme token for the surface color (`var(--t-chat-surface-bg)` — the transcript sits on the solid chat surface per the theme spec), never a hardcoded `#000`.

### Repo conventions to follow

- Never hardcode rgba/`#000` on themeable surfaces — use `var(--t-*)` (CLAUDE.md Critical Rules; `--t-chat-surface-bg` is the transcript's paper color).
- Inline styles only.
- The scroll-driven `@property` fade (`globals.css:1662` `@supports (animation-timeline: scroll())`) can stay for terminal viewports (`.cortex-terminal-fade .xterm-viewport` doesn't stream React children the same way) — only the **transcript** scroller needs the overlay treatment. Keep `.cortex-scroll-fade-y` on the terminal usage; drop it from `ChatMessageList`.

### Steps

1. `ChatMessageList.tsx:139` — wrap the scroller in a `position:relative` parent; remove `cortex-scroll-fade-y` from the scroller's className; add the two static overlay divs as siblings using `var(--t-chat-surface-bg)`.
2. Repeat the wrap for `AgentPanel.tsx:337` and `CollideProposalCard.tsx:201` (match each element's existing top/bottom fade sizes — 16/32 and 0/16 respectively).
3. Leave `globals.css:1633` `.scroll-fade-y` / `.cortex-terminal-fade` rule in place for the terminal viewport; it is no longer applied to streaming React lists.

### Boundaries

- Do NOT change scroll behavior, scroll-follow (`noteUserScroll`), or message rendering.
- Overlays must be `pointer-events:none` so clicks pass through.
- If a scroller's parent already has a non-`relative` position that this would disturb, STOP and report.

### Verification

- **Mechanical**: `npx tsc --noEmit` clean.
- **Feel check**: dispatch/stream an orchestrator turn. The top and bottom edges fade identically to before, and DevTools Performance over a streaming turn shows no per-token mask re-composite on the scroller (check the Layers/paint flashing — the scroll body should not repaint full-height each token).
- **Done when**: the transcript fade is visually unchanged and the mask no longer lives on the streaming element.

---

## 003 — Tile morph: animate transform, not left/top/width/height

- **Status**: DONE 2026-07-27 — FLIP on the leaf wrapper (step 3). The transform-only form in "Target" was rejected: a resting `scale(rect.width, rect.height)` would shrink terminal glyphs permanently, not just during the morph. The percentage rect stays the untransitioned resting layout; a structural change (split / merge / close) replays it as `translate()+scale()` back to the old box, then tweens to `none` on the next frame. Ratio-only changes (split-handle drag) now SNAP instead of tweening — the panes track the handle rather than lagging 220ms behind it, and a resize relayouts once per mousemove instead of once per frame.
- **Commit**: a5e5b2fd
- **Severity**: HIGH
- **Category**: 5 (Performance)
- **Estimated scope**: 1 file (`SessionTileSurface.tsx`), medium-hard

### Problem

When tiles split/merge/rearrange, each leaf animates its geometry via layout properties:

```tsx
// src/components/desktop/workspace-terminal/SessionTileSurface.tsx:125 — current
style={{
  left: `${rect.left * 100}%`, top: `${rect.top * 100}%`,
  width: `${rect.width * 100}%`, height: `${rect.height * 100}%`,
  // …
  transition: 'left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1), width 220ms cubic-bezier(0.22, 1, 0.36, 1), height 220ms cubic-bezier(0.22, 1, 0.36, 1)',
}}
```

`left/top/width/height` transitions trigger layout + paint + composite for the whole subtree each frame — on the tile that also hosts a live terminal/chat. On the Intel floor this drops frames during rearrange.

### Target

Render each leaf at a fixed base box and animate only `transform: translate() scale()` to move it from its old rect to its new one — GPU-composited. The percentage rect stays the resting layout; the transition property becomes `transform` only.

Because the rects are percentages of the container, the cleanest conversion is FLIP-style: keep `left/top/width/height` as the **final** resting values (no transition on them), and on rect change apply an inverse `transform` that snaps the element to its previous box, then transition that transform to `none`. If FLIP is too heavy for this executor, the acceptable simpler target is: give the leaf a fixed `inset:0` full-container box, and express its rect purely as `transform: translate(left, top) scale(width, height)` with `transform-origin: top left`, transitioning `transform` only:

```tsx
/* target (transform-only form) */
style={{
  position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
  transform: `translate(${rect.left*100}%, ${rect.top*100}%) scale(${rect.width}, ${rect.height})`,
  transformOrigin: 'top left',
  transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
}}
```

Note: `scale()` on a tile scales its children visually. If the tile content must NOT scale (terminal text), the FLIP approach (animate a wrapper's transform, keep content at natural size) is required — see Boundaries.

### Repo conventions to follow

- House curve `cubic-bezier(0.22, 1, 0.36, 1)`, 220ms preserved.
- `computeTileLayout` / leaf-rect map already exists (`SessionTileSurface.tsx:9` doc) — reuse the same `rect` values, only change how they are applied to the DOM.

### Steps

1. Read `SessionTileSurface.tsx` fully — understand how `rect` and children (terminal/chat panes) are composed, and whether content can tolerate transient `scale`.
2. If content tolerates transient scale during the 220ms transition (it visually rescales then settles — often acceptable for a quick morph): apply the transform-only target above.
3. If content must not scale (crisp terminal glyphs throughout): implement FLIP on the leaf wrapper — on `rect` change, compute the delta from the previous rect, set an inverting `transform` with `transition:none`, then on the next frame set `transform:none` with `transition:'transform 220ms …'`. Keep `left/top/width/height` as the resting layout with no transition.
4. Remove `left/top/width/height` from the `transition` string in all cases.

### Boundaries

- Do NOT change the tile tree, `computeTileLayout`, or split logic — only the per-leaf application + transition.
- Do NOT introduce a dependency (no react-flip-toolkit); hand-roll or use framer `layout` only if already imported here.
- If terminal glyphs visibly smear during the morph with the scale approach, switch to FLIP; if FLIP is out of scope for you, STOP and report which approach the tile needs.

### Verification

- **Mechanical**: `npx tsc --noEmit` clean.
- **Feel check**: split a tile, then merge it; drag the split handle. In DevTools Performance the rearrange should show composite-only work (no purple "Layout" bars per frame). Terminal text stays legible through the morph.
- **Done when**: tile geometry animates via `transform` only and the rearrange holds frame rate on the Intel build.

---

## 004 — Replace `transition: all` with explicit property lists

- **Status**: DONE 2026-07-27
- **Commit**: a5e5b2fd
- **Severity**: MEDIUM
- **Category**: 5 (Performance)
- **Estimated scope**: ~23 sites across desktop, mechanical

### Problem

`transition: all` animates every property that changes — including `box-shadow`, layout, and colors — off the GPU (AUDIT §5: always a finding). 23 occurrences in `src/components/desktop`, e.g.:

```tsx
// src/components/desktop/Canvas.tsx:275 — current
transition: 'all 100ms cubic-bezier(0.22, 1, 0.36, 1)',   // hover mutates background + color
// src/components/desktop/workspace-terminal/WorkspaceChatPane.tsx:530 — current
transition: 'all 150ms cubic-bezier(0.22, 1, 0.36, 1)',
```

### Target

For each site, replace `all` with the exact properties the element actually animates (inspect the `onMouseEnter`/`:active`/state code adjacent to each). Enumerate only what changes, keeping the same duration/curve:

```tsx
/* target — Canvas.tsx:275 (hover changes background + color) */
transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1), color 100ms cubic-bezier(0.22, 1, 0.36, 1)',
```

Where an element animates `transform`/`opacity`, list those. Never leave `all`.

### Repo conventions to follow

- Keep the house curve and existing duration for each site — this is a safety fix, not a retiming.
- One site already does it right: `globals.css:1615` `.review-diff-comment-trigger` enumerates `opacity, background, color`.

### Steps

1. `grep -rn "transition: 'all\|transition:'all\|transition: \`all" src/components/desktop` — enumerate all 23.
2. For each, read the surrounding handlers to see which props mutate; replace `all` with that explicit list at the same duration/curve.
3. Prioritize hover-heavy chrome (`Canvas.tsx:275`, `WorkspaceChatPane.tsx:530`) but fix every occurrence.

### Boundaries

- Motion properties only — do not change what the hover/active handlers set, only the transition list.
- If a site genuinely animates 4+ distinct props (rare), it may be simplest to list them; do not silently drop one.

### Verification

- **Mechanical**: `grep -rn "transition: 'all\|transition:'all" src/components/desktop` returns 0. `npx tsc --noEmit` clean.
- **Feel check**: hover the Canvas close button and the WorkspaceChatPane suggestion rows — visual behavior unchanged, but only the intended props transition.
- **Done when**: no `transition: all` remains in desktop components.

---

## 005 — Layout-property animations → transform

- **Status**: DONE 2026-07-27 — split across two same-day passes: TSX sites (steps 1/4/5) in the components pass below, `compactPulse` + `slide-in-preview` (steps 2–3) in the plan-001 CSS pass noted further down.
  - `AnalyticsPage.tsx` bar fill → full-width fill + `transform: scaleX(pct/100)`, `transformOrigin:'left'`, transitions `transform` only.
  - `DictationPill.tsx` shell → `width` removed from the transition list. It already snaps in 8px steps, which reads as growth; tweening it restarted the tween on every partial-transcript token.
  - `Onboarding.tsx` step dot → transition removed rather than converted. The doc's fixed-20px-pill + `scaleX` widens a 6-step row from 90px to 150px (67%) on the first-run surface; the dots now snap on a discrete, user-initiated step change. A transform-only morph that preserves the resting geometry needs a sliding-pill rebuild of `StepIndicator` — worth doing, but it's a design change, not a motion fix.
- **Commit**: a5e5b2fd
- **Severity**: MEDIUM
- **Category**: 5 (Performance)
- **Estimated scope**: 5 sites, small-medium
- **Partial 2026-07-27** (plan-001 pass): step 2 and step 3 are done. `compactPulse` was DELETED rather than rewritten — a re-grep found zero consumers repo-wide. `slide-in-preview` is now `translateY(-8px)→0` + opacity, consumer `WorkspaceTerminalRoot.tsx:281` unchanged (same keyframe name, same 300ms ease-out). Steps 1 (`AnalyticsPage`), 4 (`Onboarding`), 5 (`DictationPill`) landed the same day in the components pass above.

### Problem

Several elements animate `width`/`max-height` (layout every frame):

```css
/* globals.css:1549 — used at WorkspaceTerminalRoot.tsx:281 'slide-in-preview 300ms ease-out' */
@keyframes slide-in-preview { from { max-height: 0; opacity: 0; } to { max-height: 2000px; opacity: 1; } }
/* globals.css:1566 */
@keyframes compactPulse { 0%{width:20%;opacity:.6} 50%{width:75%;opacity:1} 100%{width:20%;opacity:.6} }
```
```tsx
// AnalyticsPage.tsx:400 — bar fill
transition: 'width 300ms cubic-bezier(0.22, 1, 0.36, 1)',
// Onboarding.tsx:116 — active step dot grows 8→20px
transition: 'width 300ms cubic-bezier(0.22, 1, 0.36, 1), background 300ms …',
// DictationPill.tsx:596 — HUD shell width recomputed on every partial transcript token
transition: `width 160ms ${SYMON_EASE}, border-color 120ms ease, box-shadow 120ms ease`,
```

### Target

- **Bar fills / progress** (`AnalyticsPage:400`, `compactPulse`): `transform: scaleX()` with `transform-origin:left`, transition `transform` only. `compactPulse` becomes `0%{transform:scaleX(.2)} 50%{transform:scaleX(.75)} 100%{transform:scaleX(.2)}` on a full-width bar.
- **`slide-in-preview` reveal**: replace `max-height` with `transform: translateY(-8px)→0` + opacity, or `clip-path: inset(0 0 100% 0)→inset(0)` if the element's height is dynamic. Keep 300ms ease-out.
- **`Onboarding.tsx:116` step dot**: animate `transform: scaleX()` on a fixed 20px-wide pill (rest at `scaleX(0.4)`), plus opacity — not `width`/`background`.
- **`DictationPill.tsx:596`**: the width recompute per token is the worst case (most-watched element). Snap width in fixed steps without transitioning `width`, or size a fixed track and animate a `transform: scaleX` inner fill. At minimum, remove `width` from the transition list so per-token width changes don't tween-thrash.

### Repo conventions to follow

- `transform-origin:left` for left-anchored bars.
- Prefer `clip-path: inset()` / `translate` percentages for reveals (AUDIT §8) over pixel offsets.

### Steps

1. `AnalyticsPage.tsx:400` — change the fill to `transform: scaleX(<ratio>)`, `transformOrigin:'left'`, `transition:'transform 300ms …'`.
2. `globals.css:1566` `compactPulse` — rewrite in `transform: scaleX`.
3. `globals.css:1549` `slide-in-preview` — rewrite as translate/opacity or clip-path; verify the `WorkspaceTerminalRoot.tsx:281` usage still reveals correctly.
4. `Onboarding.tsx:116` — fixed-width pill + `scaleX`/opacity.
5. `DictationPill.tsx:596` — remove `width` from the transition (keep `border-color`/`box-shadow` out too if they loop; see plan 009 for the filter). Step width instantly or via a `scaleX` inner track.

### Boundaries

- Do not change the pill's width *logic* (`pillWidth` computation, `DictationPill.tsx:332`), only how the change is presented.
- `.o8-fam`/`.o8-rev` untouched.

### Verification

- **Mechanical**: `npx tsc --noEmit` clean.
- **Feel check**: watch the dictation pill during live partial transcripts — no width jitter/thrash. Analytics bars and onboarding dots animate identically to before. DevTools Performance shows no Layout bars for these.
- **Done when**: none of these five animate `width`/`max-height`.

---

## 006 — Extend reduced-motion coverage to non-locked infinite loops

- **Status**: TODO
- **Commit**: a5e5b2fd
- **Severity**: MEDIUM
- **Category**: 6 (Accessibility)
- **Estimated scope**: 1 CSS block, small
- **Scope shrank 2026-07-27** (plan-001 pass): `pulse-dot`, `alert-bell-shake`, `compactPulse` and `blink` were deleted outright — all four had zero consumers, so there is nothing left to freeze. `o8-text-shimmer` is now an opacity pulse and `AgentPanelExtraAgentRow.tsx` carries the `.o8-text-shimmer` class, so the existing class-based freeze catches the last inline consumer. Remaining loops for this plan: `spin`, `timelineNowPulse`, `o8-sweep-circle`, `tab-label-shimmer`, `o8ToolChipPulse`.

### Problem

The reduce block freezes only the loader family + a few dot shimmers:

```css
/* src/app/globals.css:2221 — current coverage */
@media (prefers-reduced-motion: reduce) {
  .o8-text-shimmer, .o8-dot-shimmer > span, .o8-pulse-circle { animation: none !important; }
  .o8-dot-shimmer > span { opacity: 0.6 !important; }
  .o8-pulse-circle { opacity: 0.7 !important; }
  .o8-orbit { animation: none !important; }
  .o8-loader-bitfield > i, .o8-loader-dispatch > i, /* … loaders … */ { animation: none !important; opacity: 0.7 !important; }
}
```

These non-locked infinite loops keep running under `reduce`: `spin` (`1554`), `pulse-dot` (`1535`), `timelineNowPulse` (`1544`), `blink` (`1786`), `o8-sweep-circle` (`1936`), `tab-label-shimmer` (`1814`), `o8ToolChipPulse` (`1837`), `alert-bell-shake` (`1756`), `compactPulse` (`1566`), and the **inline** `o8-text-shimmer` from `shimmerTextStyle` (the class-based freeze above does not catch an inline `animation` — see plan 001, which converts it to opacity; if 001 lands first this one is moot for shimmer).

### Target

Extend the existing block to freeze these to a legible resting frame. Prefer targeting the keyframe via the consuming class; where consumers use inline `animation` (spinners often do), a resting override is still worth adding by class where one exists.

```css
/* target — add inside the existing @media (prefers-reduced-motion: reduce) block */
.o8-tool-chip-pulse,           /* o8ToolChipPulse */
[class*="pulse-dot"],
[class*="timeline-now"],       /* timelineNowPulse */
[class*="sweep-circle"] {      /* o8-sweep-circle */
  animation: none !important;
  opacity: 0.85 !important;
}
/* spinners: freeze to a static ring rather than mid-spin */
[class*="spinner"], .o8-spin { animation: none !important; }
```

Because several of these are applied by inline `animation:` strings rather than a stable class, the executor must first map each keyframe to how it's applied (className vs inline) and add the correct selector. Spinners (`spin`) that genuinely indicate in-progress work may keep a slow static state; do not remove the loader's meaning — freeze the motion, keep it visible (the existing loader block already models this: `opacity:0.7`).

### Repo conventions to follow

- Match the existing block's shape: `animation: none !important` + a resting `opacity`/`transform`.
- Reduced motion means *gentler*, not *gone* — keep opacity/legibility (AUDIT §6).

### Steps

1. For each keyframe listed, `grep` its consumers to find the applied className (or confirm inline). Build the selector list.
2. Add the selectors to the `globals.css:2221` reduce block with `animation:none` + a resting frame.
3. Leave `.o8-fam`/`.o8-rev` (already handled at 2295/2345) alone.
4. If plan 001 already converted `o8-text-shimmer` to opacity, keep freezing it too (opacity pulse under reduce should also stop).

### Boundaries

- Do NOT add `* { animation: none }` blanket kills — that would freeze the locked status families' meaning. Target explicitly.
- CSS only; no component changes.

### Verification

- **Mechanical**: `npx tsc --noEmit` unaffected (CSS only).
- **Feel check**: DevTools Rendering → "Emulate prefers-reduced-motion: reduce". Confirm spinners/pulses/shimmers freeze to a legible resting frame while status meaning (loader visible, active row still highlighted) is preserved. Locked `.o8-fam` dots still behave per their own reduce handling.
- **Done when**: no non-locked infinite loop moves under `reduce`.

---

## 007 — Introduce motion tokens (curve + durations + spring presets)

- **Status**: TODO
- **Commit**: a5e5b2fd
- **Severity**: MEDIUM
- **Category**: 7 (Cohesion & tokens)
- **Estimated scope**: `globals.css` + 1 TS constants file; adoption incremental

### Problem

The house ease-out `cubic-bezier(0.22, 1, 0.36, 1)` is hand-typed **362×**; springs have drifted (stiffness 360/380/400/420, damping 28/30/32). No `--ease-*`/`--duration-*`/spring token exists, so there is no single place to tune motion and near-duplicates accrete.

### Target

Define tokens that **preserve current values** (this is consolidation, not a feel change):

```css
/* target — add to :root in src/app/globals.css */
:root {
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);   /* the existing house curve, unchanged */
  --ease-standard: cubic-bezier(0.34, 1.36, 0.64, 1); /* the existing slight-overshoot variant */
  --dur-press: 120ms;
  --dur-hover: 150ms;
  --dur-pop: 200ms;
  --dur-panel: 300ms;
}
```

```ts
/* target — src/lib/desktop/motion.ts (new) or nearest existing shared consts */
export const SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const;      // house default
export const SPRING_SNAPPY = { type: 'spring', stiffness: 520, damping: 32 } as const;
```

### Repo conventions to follow

- Inline styles reference CSS vars fine: `transition: 'transform 150ms var(--ease-out)'`.
- Framer configs import the shared `SPRING` constant instead of re-typing `{stiffness:400,damping:30}`.
- Do NOT swap the curve for AUDIT.md's `0.23,1,0.32,1` — tokenize the value already shipping (362 sites depend on its feel).

### Steps

1. Add the `--ease-*`/`--dur-*` vars to `:root` in `globals.css`.
2. Create/locate a shared `motion.ts` exporting `SPRING`/`SPRING_SNAPPY`; export the near-variant springs collapsed to these two where the difference is imperceptible (leave a deliberately distinct spring alone).
3. **Do not** mass-rewrite all 362 sites in one PR. Land the tokens; migrate opportunistically (a follow-up sweep, or as files are touched by plans 001–006). Note the migration path in `docs/` or a code comment.

### Boundaries

- No feel change — token values equal current inlined values.
- Do not introduce a new motion library or CSS framework.

### Verification

- **Mechanical**: `npx tsc --noEmit` clean; `npm run lint` clean.
- **Feel check**: spot-check two migrated components against their pre-change behavior — identical.
- **Done when**: tokens exist and at least the plan-001–006 touched files reference them instead of inlining.

---

## 008 — Bring message-entrance durations under the UI budget

- **Status**: TODO
- **Commit**: a5e5b2fd
- **Severity**: MEDIUM
- **Category**: 2 (Easing & duration)
- **Estimated scope**: 2 files, small

### Problem

Chat message/list entrances run 400ms — over the <300ms UI budget (AUDIT §2), so streamed messages feel like they drift in:

```tsx
// WorkspaceChatPane.tsx:213, 410, 462, 531 — current
animation: `llmFadeIn 400ms ease-out ${…}ms both`,
// ChatSurface.tsx:191 — current (same llmFadeIn 400ms family)
```

### Target

Cut to 220ms (entrance → `ease-out`, already correct direction). Keep the per-item stagger delay:

```tsx
/* target */
animation: `llmFadeIn 220ms cubic-bezier(0.22, 1, 0.36, 1) ${…}ms both`,
```

### Repo conventions to follow

- House curve for entrances; `llmFadeIn` keyframe (opacity+translateY) is already compositor-safe — only the duration changes.
- If plan 007 landed, use `var(--ease-out)` and a `--dur-*` token.

### Steps

1. `WorkspaceChatPane.tsx` — replace the four `400ms` in `llmFadeIn` strings with `220ms` (and swap `ease-out` → the house curve).
2. `ChatSurface.tsx:191` — same.
3. Verify the stagger delay expression is untouched.

### Boundaries

- Duration/curve only; do not alter stagger step (`index * 50ms`) or the keyframe.

### Verification

- **Feel check**: stream a multi-message turn — messages settle promptly, stagger still reads. DevTools Animations panel at 10% playback: each item ~220ms.
- **Done when**: no chat entrance exceeds 250ms.

---

## 009 — Drop the paint `filter` transition on the dictation EQ

- **Status**: DONE 2026-07-27 — `filter` is gone from the canvas style and the transition (`opacity 180ms ease` remains). The hot/cool emphasis moved into the draw call as an eased `ctx.globalAlpha` (1 → 0.86, lerped at 0.12 per frame like the bar levels), so the voice toggle costs no paint and still eases.
- **Commit**: a5e5b2fd
- **Severity**: MEDIUM
- **Category**: 5 (Performance)
- **Estimated scope**: 1 file, small

### Problem

```tsx
// src/components/desktop/dictation/DictationPill.tsx:231 — current
filter: (speaking || listening) ? 'saturate(1.06) brightness(1.04)' : 'saturate(0.96) brightness(0.98)',
transition: 'opacity 180ms ease, filter 180ms ease',
```

`filter` is a paint property; transitioning it on every voice toggle violates the compositor lock (the same class as the removed framer `blur()`).

### Target

Remove `filter` from the transition and from the animated style. Bake the saturation/brightness difference into the canvas gradient itself (draw the "hot" vs "cool" state directly), or cross-fade two stacked opacity layers (a brighter canvas over a dimmer one, animating `opacity`).

```tsx
/* target — minimal: keep opacity feedback only */
transition: 'opacity 180ms var(--ease-out)',
/* and render the speaking/listening emphasis via canvas draw or an opacity layer, not filter */
```

### Repo conventions to follow

- Opacity/transform only for motion.
- The EQ is canvas-drawn — the emphasis can live in the draw call (`DictationPill.tsx` EQ render), which is the cleanest place.

### Steps

1. Remove `filter` from the animated inline style at `:231` and from the `transition` list.
2. Move the speaking/listening emphasis into the canvas gradient (draw hotter colors when `speaking||listening`) OR add a second opacity-animated highlight layer.

### Boundaries

- Do not change the EQ audio logic — only how the active state is visually emphasized.

### Verification

- **Feel check**: start a voice session — the EQ still brightens on speech, with no `filter` in the computed style. DevTools shows no paint on the toggle.
- **Done when**: no `filter` is transitioned in `DictationPill`.

---

## 010 — Stop animating the command palette open (keyboard action)

- **Status**: TODO
- **Commit**: a5e5b2fd
- **Severity**: MEDIUM
- **Category**: 1 (Purpose & frequency)
- **Estimated scope**: 1 file, small

### Problem

⌘⇧K opens the palette with a spring scale + slide — a 100+/day keyboard action that AUDIT §1 says must not animate (Raycast opens instantly). The app's own sibling `QuickActionPalette` already teleports, so this is also inconsistent:

```tsx
// src/components/desktop/CommandPalette.tsx:531 — current
<motion.div key="palette-card"
  initial={{ opacity: 0, scale: 0.96, y: -6 }}
  animate={{ opacity: 1, scale: 1, y: 0 }}
  exit={{ opacity: 0, scale: 0.97, y: -4 }}
  transition={SPRING}
  …
```

### Target

Keep the subtle overlay opacity fade (`:520`, `duration: 0.12` — a scrim fade is fine and prevents a harsh flash), but make the card appear instantly, or at most an opacity-only 80–100ms fade — no scale/slide on a keyboard-summoned surface:

```tsx
/* target */
<motion.div key="palette-card"
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  exit={{ opacity: 0 }}
  transition={{ duration: 0.09 }}
  …
```

### Repo conventions to follow

- Exemplar: `orchestrator/QuickActionPalette.tsx:91` mounts gated with no motion — this palette should match that crispness.

### Steps

1. `CommandPalette.tsx:531` — drop `scale`/`y` from `initial`/`animate`/`exit`; set `transition={{ duration: 0.09 }}` (opacity only). Leave the overlay scrim fade at `:526` as-is.

### Boundaries

- Keep focus/keyboard handling and the overlay scrim; motion change only.

### Verification

- **Feel check**: hammer ⌘⇧K open/close repeatedly — the palette is instantly present each time, no spring settle, no restart artifact. Matches QuickActionPalette.
- **Done when**: the palette card has no scale/slide on open.

---

## 011 — (Additive) Missed-opportunity transitions

- **Status**: TODO
- **Commit**: a5e5b2fd
- **Severity**: LOW (additive)
- **Category**: 8 (Missed opportunities)
- **Estimated scope**: 4 small independent edits

These are optional polish — each prevents a teleport. Do them only if the top-10 are done. Each is independent.

1. **O8Panel tab crossfade** — `O8Panel.tsx:729`: tabs swap via `display:'flex'/'none'`. Add a 130ms opacity crossfade on the incoming active panel (`@starting-style` or a `data-active` opacity transition). Do not animate width/layout — opacity only. Purpose: connect spatially-related panels (§8).
2. **ToolCallChipCluster expand/collapse** — `orchestrator/ToolCallChipCluster.tsx:185`: the "+N more"/"Collapse" render swap and the `:278` detail dialog teleport. Wrap in a height+opacity transition (or framer `AnimatePresence` with the house `SPRING`); stagger 30–50ms is optional and must not block interaction.
3. **ChatToastStack enter/exit** — `thoughts/chat-panel/ChatToastStack.tsx:33` (+ `ClearToast`): wrap toasts in `AnimatePresence`; enter/exit with `opacity` + `translateY(8px)` at the house `SPRING`. Occasional surface → standard animation is warranted (§1).
4. **Trigger-anchored popover entrances** — `PacketDetailsPopover.tsx:171`, `ComposerPopover.tsx:103`, `llm-chat/ModelPicker.tsx:94`: add `transform-origin` set to the trigger corner + `scale(0.96)`+opacity enter (150–200ms, house curve). Copy `SessionPillContextMenu.tsx:100`, which already does this correctly. Skip pure hover-cards (frequency rule).

### Boundaries

- Opacity/transform only. No layout animation. Reduced-motion: gate any translate on `prefers-reduced-motion` (keep opacity).

### Verification

- **Feel check**: each surface now animates in from a sensible origin instead of teleporting; reduced-motion drops the movement but keeps the fade.

---

## Execution order & dependencies

| Order | Plan | Sev | Why here | Depends on |
|-------|------|-----|----------|-----------|
| 1 | 001 Paint-loop shimmer + dead keyframes | HIGH | Idle CPU/heat; extends the compositor lock | — |
| 2 | 002 Transcript scroll-fade off scroller | HIGH | Jank on the most-watched surface | — |
| 3 | 003 Tile morph → transform | HIGH | Frame drops on rearrange | — |
| 4 | 004 Kill `transition: all` | MED | Broad off-GPU cleanup, mechanical | — |
| 5 | 005 Layout props → transform | MED | Width/max-height thrash, incl. dictation | — |
| 6 | 006 Reduced-motion coverage | MED | A11y; easier after 001 converts shimmer | 001 (shimmer) |
| 7 | 007 Motion tokens | MED | Foundational; adopt as other plans touch files | — (enables others) |
| 8 | 008 Entrance durations | MED | Snappier streamed messages | 007 optional |
| 9 | 009 Dictation `filter` | MED | Paint on voice toggle | overlaps 005 (same file) |
| 10 | 010 Palette open motion | MED | Keyboard action shouldn't animate | — |
| 11 | 011 Missed-opportunity polish | LOW | Additive; after corrective work | 007 optional |

Notes: **005 and 009 both touch `DictationPill.tsx`** — do them together or 005 first. **006 is cleaner after 001** (shimmer becomes opacity). **007 has no hard dependents** but every other plan can consume its tokens if it lands first. Plans 001–005 + 010 are the operator-felt wins; 006–009 are correctness/craft; 011 is optional delight.
