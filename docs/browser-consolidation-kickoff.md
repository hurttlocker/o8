# Browser Consolidation — New-Agent Kickoff Prompt

Copy the block below verbatim into a fresh agent in `~/o8` to execute the 6-stage
embedded-browser consolidation (item #1 of [`platform-teardown.md`](./platform-teardown.md)). It assumes
zero prior context and points at every file the audit surfaced.

---

```
You are executing a planned, greenlit refactor of o8's embedded-browser stack. o8 is a
Next.js 16 + Tauri v2 desktop app — the governance layer for autonomous AI coding agents.
Repo: $HOME/o8.

BEFORE TOUCHING CODE, read in order:
1. $HOME/o8/CLAUDE.md   — hard rules (inline styles only, no CSS classes,
   theme tokens, tsc before commit, explicit-pathspec commits, etc.)
2. $HOME/o8/docs/platform-teardown.md  — the plan; section "1. Agent + human
   browser…" holds the locked decisions + the 6 stages. This prompt expands it.

## MISSION
Consolidate o8's sprawling, half-overlapping embedded-browser stack into ONE unified model:
a single browser surface that is BOTH agent- and human-usable, where the AGENT drives with a
continuous Claude-style GHOST CURSOR (exactly how Claude drives the Google-native Chrome MCP —
a visible cursor moving on the live page) while the HUMAN uses their own native cursor on the
same surface; plus ONE "Design Mode" grab — click a live element → capture rich
HTML/CSS/computed-styles/accessibility/screenshot → inject into the agent prompt — that works
on BOTH the dashboard chrome AND the embedded browser.

THE #1 REQUIREMENT: leave NOTHING hanging or dead after the refactor. Every obsoleted path is
either folded into the new system or explicitly deleted, with a grep proving no orphan refs.

## LOCKED DECISIONS (do not re-litigate)
1. UNIFY all grab paths into ONE Design Mode. The existing dashboard Design Mode + BOTH element
   pickers + the panel annotation flow collapse into one system that works on dashboard chrome
   AND the embedded browser, emits the rich payload, and keeps the Cmd+Shift+D keybinding.
2. KILL the `?pick=1` script-strip proxy mode. The grab reads the LIVE same-origin page (via the
   in-page agent) so the page stays fully interactive for human AND agent at the same time.
3. FULL under-the-hood consolidation: one shared selector util, one grab/picker path, one
   standardized "agent-driving" indicator (cursor + glow) across canvas AND panel.

## CURRENT-STATE MAP (from a full audit — trust these refs but verify before editing)
Render surfaces (THREE, not two):
- Canvas browser cards: src/app/preview/canvas-glass/browser-card.tsx (iframe :475-494,
  data-o8-browser="canvas"/data-o8-active; spawnBrowserCard canvas-glass/page.tsx:2036;
  browserCards state page.tsx:335; EngineLiveView :79-118 = polled-JPEG of headless engine).
- Panel Browser tab: src/components/desktop/O8BrowserPane.tsx (iframe :751-764,
  data-o8-browser="panel"; mounted O8Panel.tsx:584-593).
- Proxy routes (the only way to get same-origin script injection):
  src/app/api/panel/iframe-proxy/route.ts (?pick=1 STRIPS all <script> :50-67, loopback :22-39),
  src/app/api/panel/proxy/route.ts (annotation; lib/panel/preview.ts),
  src/app/api/browser/proxy/route.ts (canvas picker; PROXY_PATH browser-card.tsx:49).
In-page agent: src/lib/browser-agent/page-agent.ts — installBrowserAgent() :254-257 (a real
  bundled MODULE, runs in app context, operates on the same-origin iframe contentDocument);
  verbs read/click/type/probe; pickFrame :46-52; selectorFor :63; paintCursor :97-130;
  pulse :133-141; PROXY_MARKERS/realUrl :31-42. Installed by O8BrowserPane.tsx:166 +
  browser-card.tsx:179.
Agent control path: o8_browser_read/click/type/wait in src/lib/mcp/o8-webview-tools.ts:538-588
  (handlers :829-879; browserAgentPost :826-828; browserAgentEval :592-599) → POST
  src/app/api/browser/agent/route.ts (tier routing :120-124; engine tier runEngineVerb :81-106;
  embedded tier evalJs :148; o8:open-browser dispatch :138). CLI: cli/src/commands/browser.ts.
  Webview socket client src/lib/mcp/o8-webview-client.ts (evalJs :522, socket :365).
  External-URL tier: src/lib/browser-engine/engine.ts (playwright-core driving headless Chrome).
  ⚠️ SEPARATE surface — do NOT conflate: o8_view_* (o8-webview-tools.ts:370-510) drives the
  o8 DASHBOARD's own Tauri webview (host chrome). o8_view_open_browser :469 OPENS the tab;
  o8_browser_* acts INSIDE it.
Ghost cursor + glow (the seed): paintCursor page-agent.ts:97-130 = amber teleport-and-fade,
  AGENT-ONLY, no continuous/human cursor. pulse :133-141 dispatches o8:browser-agent-pulse;
  canvas listens browser-card.tsx:181-193 (agentGlow boxShadow :464); the PANEL pane does NOT
  listen (asymmetry to fix).
Human usability today: both embedded iframes are interactive by default (direct-load → human
  clicks/types/scrolls the live SPA). BUT entering picker mode swaps to the ?pick=1 script-strip
  proxy → page goes dead. So today human-interaction and grab are mutually exclusive — that's the
  core thing this refactor fixes.
Grab payload seed: src/lib/browser/element-picker-bridge.ts buildPayload :168-197 ALREADY
  captures tagName/id/classList/text/attributes/computedStyles/boundingRect/cssSelector/
  innerHTML/parentChain (~80% of the grab). O8ElementPanel.tsx + PickedElement type :1-26 = the
  readout/insert UI to reuse.
Existing "Design Mode" (NAME + Cmd+Shift+D collision): src/hooks/useDesignMode.ts +
  src/components/desktop/DesignModeOverlay.tsx (wired dashboard/page.tsx:622,4023-4034,2648).
  Operates on the DASHBOARD's own DOM via elementsFromPoint :257, emits only text "use
  o8_view_screenshot to inspect this region" :330 — NO HTML/CSS/a11y, does NOT touch the iframe.
Annotation flow (overlaps the grab): O8BrowserPane.tsx:318-412 (captureAnnotationScreenshot,
  handleSendVisualAnnotation) + /api/panel/proxy + /api/panel/annotation-screenshot +
  lib/panel/preview.ts formatPreviewAnnotationContext. Near-duplicate info-bars selectedElement
  vs visualAnnotation O8BrowserPane.tsx:766-924. Iframe resizes calc(100% - 32px) :761 when one
  is open (reconcile with new grab chrome).
Audit attribution: browser_acted verb lane/types.ts:203; recordAction route.ts:53-69 →
  recordLaneEvent lane/events.ts:23-28; findLatestLaneByPacket route.ts:7. ONLY fires for agent
  verbs WITH packetId; probe excluded by design; human/picker/annotation grabs record NOTHING.
FOUR divergent selectorFor impls: page-agent.ts:63 (:nth-of-type, early-exit, app context),
  browser-card.tsx:121 cssSelectorFor (app context), browser-engine/engine.ts:37 (inside
  collectPageState, PLAYWRIGHT-SERIALIZED → can't import), element-picker-bridge.ts:58
  uniqueSelector (:nth-child, INJECTED STRING → can't import).

## TARGET ARCHITECTURE
One shared browser surface. The agent drives with a continuous ghost cursor (extended from
paintCursor) that never blocks the human's native pointer events. ONE Design Mode (Cmd+Shift+D)
that, when the pointer is over a data-o8-browser frame, grabs via the in-page agent reading the
LIVE same-origin page; when over dashboard chrome, grabs the dashboard DOM — both producing the
SAME rich GrabbedElement payload (HTML/CSS/computed-styles/a11y/screenshot) injected into the
agent prompt. External URLs route grab through the engine tier (page-agent returns crossOrigin
for them). Every grab/action — agent OR human — records a browser_acted lane event.

## THE 6 STAGES — each ends tsc-clean and is committed+pushed separately
STAGE 1 — Shared selector util.
  Create src/lib/browser/selector.ts exporting a canonical, SELF-CONTAINED selectorFor(el) (use
  the page-agent/engine algorithm: id shortcut → walk ≤5 levels → :nth-of-type among same-tag
  siblings → early-exit when querySelectorAll(...).length===1). Also export SELECTOR_FOR_SOURCE
  (the function's source string) for the serialized contexts. Migrate: page-agent.ts:63 and
  browser-card.tsx:121 IMPORT it (delete locals). engine.ts:37 and element-picker-bridge.ts:58
  CANNOT import (serialized/injected) — embed SELECTOR_FOR_SOURCE into their script strings.
  Picker-bridge behavior changes (:nth-child→:nth-of-type+early-exit) — intended consolidation.
STAGE 2 — Grab payload + verb.
  Define a canonical GrabbedElement type by extending element-picker-bridge.buildPayload with the
  full computed-style subset + accessibility info (role, accessible name, aria-*) + a screenshot
  hook (pragmatic: crop a Tauri webview screenshot, or html2canvas for same-origin — your call).
  Add a grab(selector) verb to page-agent.ts (reads the live same-origin element). Wire it:
  o8_browser_grab in o8-webview-tools.ts (schema+handler+browserAgentEval) → 'grab' tier in
  /api/browser/agent → record browser_acted.
STAGE 3 — Unify Design Mode.
  Make useDesignMode/DesignModeOverlay target the embedded browser: pointer over a
  data-o8-browser frame → route grab through the page-agent grab verb; over dashboard chrome →
  enrich the existing elementsFromPoint path to emit the SAME GrabbedElement payload (not the
  "use o8_view_screenshot" text). Fold the panel annotation flow into this (replace
  handleSendVisualAnnotation with the unified grab). One overlay, one Cmd+Shift+D, one result
  panel (reuse O8ElementPanel; migrate PickedElement→GrabbedElement).
STAGE 4 — Delete dead paths (grep-verify zero orphans before commit).
  Remove: the ?pick=1 script-strip mode (iframe-proxy/route.ts + proxiedPickUrl in O8BrowserPane);
  the canvas inline picker (browser-card.tsx ~:120-298 armPicker/cssSelectorFor/highlight); the
  annotation duplicate IF Stage 3 subsumed it (captureAnnotationScreenshot,
  handleSendVisualAnnotation, /api/panel/annotation-screenshot, the visualAnnotation info-bar,
  formatPreviewAnnotationContext). `grep -rn` each removed symbol/route/event to prove no refs.
STAGE 5 — Shared cursor + unified glow.
  Extend paintCursor into a CONTINUOUS agent ghost cursor (persistent element, smooth motion to
  targets, visible while the agent drives, NEVER captures/blocks human pointer events). Make the
  panel pane listen for o8:browser-agent-pulse so the "agent-driving" indicator is identical on
  canvas AND panel.
STAGE 6 — Audit + sweep.
  Route human-initiated grabs through recordLaneEvent('browser_acted', …) (route.ts currently
  skips human/no-packetId calls). Reconcile the iframe calc(100% - 32px) resize with new chrome.
  Final repo-wide orphan grep across the browser subsystem. Run `npm test`.

## GOTCHAS
- selectorFor lives in 3 runtimes (app-import / playwright-serialized / injected-string) — see S1.
- page-agent only reaches same-origin/proxied localhost frames; external URLs return crossOrigin
  → must route grab through the engine tier (browser-engine/engine.ts), not page-agent.
- probe stays excluded from audit. Don't conflate o8_view_* (host webview) with o8_browser_*.
- Watch the 800-line file ceiling (CLAUDE.md) — decompose before exceeding.

## CONSTRAINTS (CLAUDE.md — non-negotiable)
- Inline styles only (style={{}}), NO CSS classes, NO CSS shorthand (paddingTop not padding),
  theme tokens var(--t-*) (never hardcoded rgba for surfaces), `as React.CSSProperties` for
  vendor-prefixed props.
- `npx tsc --noEmit` BEFORE EVERY commit. `npm test` (vitest) at the end.
- Commit per stage with EXPLICIT pathspec (git add <specific files>; NEVER `git add -A` — the
  tree has pre-existing dirty files like o8.md / src-tauri/Cargo.lock — leave them untouched).
  Prefix refactor:/feat:/fix:. No backticks or $ inside double-quoted -m (use single quotes or
  multiple -m).
- `git push origin main` after each stage (rebase if origin advanced — other agents commit
  concurrently). DO NOT SHIP (no `npm run ship`, no `npm version`).

## DEFINITION OF DONE
Full parity (every prior capability preserved or intentionally replaced) · ZERO dead/orphaned
code (grep-proven) · tsc + npm test green · each of the 6 stages committed + pushed to main · no
ship. If a decision is genuinely ambiguous mid-refactor, make the call that best serves "one
unified system, nothing left dead," note it in the commit body, and keep moving.
```
