# Research Notes — X Threads

> Superseded framing, 2026-05-24: the active mobile research target is the
> native o8-mobile repo at
> `/Users/marquisehurtt/o8-mobile/docs/mobile-ui-pattern-notes.md`. Keep this
> file as older Cortex/o8 research context; do not use its web/dashboard wording
> as the implementation target for mobile.

## 1. Karpathy thread — bigger IDE, not no IDE

### Core idea
Karpathy’s argument is that the IDE is not disappearing.
It is being promoted upward.

The basic unit of interest is shifting from:
- one file
- one buffer
- one human typing session

to:
- one agent
- one run
- one squad
- one orchestrated workflow

### Key implications
The next IDE likely needs to support:
- agent roster visibility
- idle / blocked / active state
- tool and terminal inspection
- usage / cost / context stats
- team-level orchestration
- better command-center UX than tmux grids

### Important follow-up in the thread
Karpathy also frames these systems as matters of **“org code.”**
That is a big idea.

It suggests that teams will increasingly want to fork and reuse:
- org structure
- review chains
- escalation rules
- memory policy
- squad topology
- workflow templates

## 2. Remodex / Phodex thread — mobile remote control is real

### Core idea
Emanuele Di Pietro showed a local-first remote-control setup for Codex on iPhone.

The key architecture:
- phone is the controller
- Mac does the heavy lifting
- a local bridge talks to the runtime
- pairing happens via QR
- relay exists for routing
- conversations and actions stay grounded in the desktop runtime

### What matters for o8
This strongly supports a day-one mobile strategy for o8.

Not “full IDE on phone.”
Instead:
- paired operator remote
- notifications
- approvals
- quick steering
- diff review
- live run watch
- memory-backed incident context

### Architectural details worth borrowing
- QR pairing
- local-first bridge
- secure paired channel
- event stream for updates
- mobile app as operator console
- self-hosted path plus possible managed relay path

## Product synthesis

These two threads fit together cleanly.

### Karpathy gives the category thesis:
**the IDE becomes an agent command center**

### Remodex gives the mobile architecture clue:
**the phone becomes the remote operator surface**

### Cortex adds the missing moat:
**memory, provenance, continuity, and organizational learning**

## Working takeaway

The strongest version of o8 is probably:
- desktop-first command center
- mobile-first remote control for alerts and approvals
- memory-native orchestration layer
- not a VS Code fork at the beginning

## 3. Notion mobile refresh — softness, floating input, and selective density

### Source
Laura Sandoval shared a short preview of Notion's refreshed mobile visual language:
https://x.com/laurasideral/status/2057860290310541659

The video was downloaded through the UGC pipeline and analyzed with Gemini 3.1 Pro Preview.

Local artifacts:
- `/Users/marquisehurtt/UGC/data/tmp/ingest/vid_GQK1f1s6dq.mp4`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/notion_2057860290310541659_frames/contact_sheet.jpg`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/notion-mobile-design-analysis-2057860290310541659.json`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/notion-mobile-design-analysis-2057860290310541659.md`

### Core idea
The refresh works because it makes mobile feel calm, approachable, and native:
- off-white canvas
- white high-radius cards
- muted pastel icon containers
- generous spacing
- soft floating input surfaces
- very low visual noise

The important lesson is not to copy Notion's exact density.
The lesson is to use softness and motion to make complex work feel less hostile on a phone.

### What Cortex should borrow
Use a floating bottom orchestrator composer as a primary mobile pattern.
It should feel omnipresent across chat, terminal, review, browser, files, and agent status instead of being trapped inside one chat screen.

Use rounded, quiet card surfaces for:
- agent status
- settings
- repo / project metadata
- task detail
- tool connections
- mobile home / inbox summaries

Use muted squircle icons to normalize chaotic developer concepts:
- repos
- file types
- tools
- agents
- browser
- terminal
- review
- approvals

### What Cortex should not copy
Do not carry Notion's low density into code surfaces.
Cortex is still an IDE companion.
Terminal, review, diff, logs, and file tree surfaces need to become compact, monospace, and information-dense.

The right pattern is:
- soft outer shell
- compact inner developer surface
- smooth transition between relaxed chat/navigation density and dense code/log density

### Fast build candidates
P0:
- floating orchestrator composer that lifts above the keyboard and safe area
- unified mobile surface switcher for Chat / Files / Review / Terminal / Browser / Agent Status

P1:
- reusable agent / task status cards
- muted service icon taxonomy
- density mode for code surfaces
- short native-feeling transitions using existing motion tooling

### Product synthesis
This Notion example updates the mobile strategy:

Mobile is still not "full IDE on a phone."
But it must feel as polished and immediate as the best consumer productivity apps.

Cortex mobile should be:
- calm enough for first-time users
- dense enough for real developer work
- centered around a persistent orchestrator composer
- built from switchable workflow surfaces rather than modal dead ends

## 4. Paulius / Komand demos — mobile is the AFK agent control plane

### Sources
Paulius shared two mobile AI coding demos:
- https://x.com/0xPaulius/status/2055955762719965570
- https://x.com/0xPaulius/status/2058454474130100456

The videos were downloaded through the UGC pipeline and analyzed together with Gemini 3.1 Pro Preview.

Local artifacts:
- `/Users/marquisehurtt/UGC/data/tmp/ingest/vid_cSPbx13L_8.mp4`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/vid_dLRfF78qKX.mp4`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/paulius_2055955762719965570_frames/contact_sheet.jpg`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/paulius_2058454474130100456_frames/contact_sheet.jpg`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/paulius-mobile-ai-coding-preview-analysis-2055955762719965570-2058454474130100456.json`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/paulius-mobile-ai-coding-preview-analysis-2055955762719965570-2058454474130100456.md`

### Core idea
These demos sharpen the mobile thesis:

Mobile AI coding is not about writing source code on a phone.
It is about keeping the desktop agent loop alive while the operator is away.

The phone should let the operator:
- inspect agent state
- open a live preview
- test what the agent built
- review changed files
- generate / approve a commit
- push or continue the run

### What the first demo proves
The first video shows a mobile agent/chat surface with an interactive web preview and git review flow.

Visible product moves:
- chat answers about current repo state
- a floating commit / git-state pill
- an embedded interactive web preview
- a changed-file review sheet
- AI-generated commit message affordance

For Cortex, the important pattern is the **floating agent state pill**.
It should represent live desktop state such as:
- files modified
- approval waiting
- preview ready
- review ready
- command failed
- terminal needs attention

Tapping the pill should open the right bottom sheet immediately.

### What the second demo proves
The second video points at a bigger preview layer:
desktop compute can stream or expose a native app preview back to the phone.

The demo appears to show an iPhone app preview driven by the Mac / desktop environment, with the phone acting as a remote testing surface.

For Cortex, this splits into two phases:

P0 / P1:
- tunnel-backed web preview for localhost dev servers
- Expo Go / deep-link preview for React Native apps where possible

Later:
- remote simulator streaming for native iOS / Android preview
- touch-event relay back to the desktop simulator
- WebRTC or VNC-style transport if the preview must be fully interactive

### What Cortex should borrow
P0:
- floating agent state pill synced over WebSocket
- full-screen mobile preview tab for tunneled localhost URLs
- preview-ready event from desktop to mobile
- tap-to-open bottom sheets for review, terminal tail, and approvals

P1:
- mobile diff review sheet
- AI commit-message generation
- one-tap commit / push after review
- mobile-safe preview session lifecycle: ready, loading, disconnected, crashed, stale

P2:
- desktop-hosted simulator streaming
- Expo-native preview bridge
- remote touch relay

### What Cortex should not copy
Do not trap serious previews inside a cramped chat cell.
Inline preview is useful as a thumbnail or quick glance, but real QA needs a full-screen preview surface with correct viewport, safe-area behavior, and navigation controls.

Do not expose a crowded model picker as the center of the mobile UI.
The mobile app should mostly route through the orchestrator, with advanced model choice hidden in settings or a secondary sheet.

Do not default to auto-approve.
Remote approval is valuable because it creates a fast human checkpoint.
Cortex should keep dangerous actions explicit, especially commit, push, deploy, file delete, package install, and shell execution.

### Product synthesis
Notion teaches the surface language: soft, calm, native, low-friction.

Paulius / Komand teaches the workflow: mobile must close the AFK loop with live preview, review, and approval.

Combined Cortex mobile direction:
- persistent orchestrator composer
- persistent agent state pill
- switchable surfaces for Chat / Files / Review / Terminal / Browser / Preview
- preview as a first-class tab, not a modal afterthought
- desktop remains the compute engine
- phone becomes the remote QA and approval surface

## 5. Open-source intake — AI Experiments and ShipSwift motion primitives

### Sources
Two open-source sources were reviewed as implementation references:
- https://github.com/mikelikesdesign/AI-experiments
- https://github.com/signerlabs/ShipSwift

Related X post:
- https://x.com/DevJohnWayne/status/2057972033582145606

Observed revisions:
- `mikelikesdesign/AI-experiments` at `b9820f43a714999cf5efb7935ba10a1598f838db`
- `signerlabs/ShipSwift` at `fe1d1c9a6aea5cb13c5a6818cd1075102b970e5a`

Both projects are MIT licensed, so code can be adapted as long as the license notice is preserved when copying substantial code.

### AI Experiments — useful interaction patterns
`AI-experiments` is a set of native SwiftUI prototypes for AI interaction design.
The code is not directly drop-in for the current web mobile surface, but the patterns are strong.

Relevant patterns:
- **Pinch Prompts:** pinch / action-triggered prompt navigator for long chat history
- **Pinch Text:** tactile compression and expansion of answer detail
- **Content Ideas / Word Slider:** two-axis and slider controls for steering tone, detail, or formality
- **AI Content Drag:** scroll or drag gesture that shifts an answer between simpler and deeper explanation
- **AI-LLM:** model switching as an object-like interaction instead of a plain dropdown
- **Quick Camera:** fast visual context capture for the AI
- **AI Nodes / Globe:** spatial knowledge exploration, useful later for memory maps

### What Cortex should borrow from AI Experiments
P1:
- prompt/history navigator for long orchestrator threads
- answer depth control for summaries, diffs, and explanations
- style/detail steering control for generated commit messages and review summaries

P2:
- camera/context capture for bug reports, screenshots, and real-world context
- memory graph / topic map inspired by nodes/globe experiments
- tactile pinch-to-summarize for dense logs, if it has a visible button fallback

Avoid:
- making pinch gestures the only access path
- camera-based emotion/reaction analysis unless explicitly opted in
- over-designed model switching in the primary mobile UI

### ShipSwift — useful component and motion primitives
`ShipSwift` is an AI-native SwiftUI component library with reusable source under `ShipSwift/SWPackage`.

Relevant components:
- `SWAnimatedMeshGradient`
- `SWFractalClouds`
- `SWInkSmoke`
- `SWDots`
- `SWScanningOverlay`
- `SWShimmer`
- `SWTypewriterText`
- `SWThinkingIndicator`
- `SWChatView`
- `SWChatInputView`
- `SWMessageList`
- `ComponentRegistry`

The strongest immediate reference is not a full component transplant.
It is the idea of a **themeable motion layer** with live-tunable parameters.

### Paper motion behind chat
The specific Cortex version should be a subtle paper / ink / grain layer behind chat.

Requirements:
- low contrast by default
- tiny movement only
- reduced-motion support
- disabled or heavily muted behind terminal, review, and dense code surfaces
- controlled by design tokens rather than hard-coded colors
- no loud plasma, chrome, or decorative orb treatment in the primary mobile chat

Good ShipSwift references:
- `SWFractalClouds` for soft drifting texture
- `SWInkSmoke` for slow domain-warped movement
- `SWScanningOverlay` for controlled scanning/noise overlays
- `SWAnimatedMeshGradient` only as a reference for palette interpolation, not as a dominant gradient background

### Implementation translation for Cortex
Current Cortex mobile is web/React, so the first implementation should port the behavior rather than copy SwiftUI:
- CSS or Canvas paper grain texture
- optional WebGL shader only if the simple version is not smooth enough
- `framer-motion` for intensity and theme transitions
- `prefers-reduced-motion` hard gate
- one central `MobileMotionTheme` registry

If / when the native `o8-mobile` path becomes the target, the SwiftUI source can be copied or adapted directly with MIT attribution.

### Product synthesis
The research wave now splits into three layers:

1. **Surface language:** Notion-style softness, cards, floating input, and selective density.
2. **Workflow:** Paulius / Komand-style AFK agent control with live preview, review, and approval.
3. **Motion and interaction primitives:** AI Experiments and ShipSwift patterns for subtle motion, prompt navigation, answer depth controls, and tunable AI UI.

This should become the mobile plan:
- persistent orchestrator composer
- persistent agent state pill
- full-screen preview surface
- mobile review / commit sheet
- subtle paper-motion chat background
- prompt/history navigator
- answer detail and review-depth controls

## 6. Open-source/pattern intake — draggable split view and background browser agents

### Sources
Two more mobile references were reviewed:
- https://x.com/imeronn/status/2057450884670406662
- https://x.com/ronithhh/status/2057588392175812855

Related implementation/source references:
- http://reactnativecomponents.com/components/screen-views/resizable-split-view
- https://60fps.design/learn/tutorials/building-an-interactive-resizable-split-view-in-react-native

The videos were downloaded through the UGC pipeline and analyzed together with Gemini 3.1 Pro Preview.

Local artifacts:
- `/Users/marquisehurtt/UGC/data/tmp/ingest/vid_3yeY7aEeWB.mp4`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/vid_gvlcFjcZvk.mp4`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/imeronn_2057450884670406662_frames/contact_sheet.jpg`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/ronith_2057588392175812855_frames/contact_sheet.jpg`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/mobile-open-source-pattern-analysis-imeronn-ronith-2057450884670406662-2057588392175812855.json`
- `/Users/marquisehurtt/UGC/data/tmp/ingest/mobile-open-source-pattern-analysis-imeronn-ronith-2057450884670406662-2057588392175812855.md`

### Resizable split view — usable now
Erencan Arica's demo shows a draggable split layout built with Expo / React Native.

The linked component page is not clearly open-source; it marks the component as not free and exposes no direct downloadable code in the page payload.
The 60fps tutorial, however, gives enough implementation detail to adapt the pattern.

Core implementation pattern:
- shared height value drives the top pane
- bottom pane fills remaining space
- drag handle uses pan gesture
- snap points are min / default / max
- high release velocity snaps to the next state
- low release velocity snaps to the nearest state
- content opacity / scale interpolates as a pane collapses or expands

For current Cortex mobile, this should be implemented in web terms:
- CSS grid/flex pane heights
- `pointerdown` / `pointermove` / `pointerup`
- `touch-action: none` on the handle
- CSS variables for pane ratio
- `framer-motion` for snap animation
- memoized pane contents so preview/diff/terminal do not re-render on every drag frame

### Cortex use
This should become a **dual-surface workspace** pattern.

Strong combinations:
- Chat + Preview
- Chat + Terminal tail
- Review summary + Diff
- Agent status + Browser preview

The key is not just resize.
The key is preserving context while the user shifts attention.

### Design rules for split view
- exactly three rest states to start: compact top, balanced, compact bottom
- no arbitrary resting heights
- show a visible drag handle
- while dragging, fade or compress low-priority controls before they get clipped
- when a pane is too small, show a compact summary instead of broken full UI
- persist the user's last split ratio per surface pair

### Background browser agent — research later
Ronith's demo shows an iOS app where an agent controls a local browser while the app is backgrounded.

The thread clarifies that the visible top element is video, driven from a live SwiftUI view that is rasterized every frame and sent into a video stream.
The useful pattern is not the exact hack.
The useful product idea is **out-of-app agent visibility**.

For Cortex:
- current web mobile should use push notifications / service worker alerts for background status
- native future should investigate Live Activities / Dynamic Island
- PiP-style video is research-only unless we have a native app path and a strong reason to spend battery/complexity

### Architecture rules for background work
Do not run important agent work inside the phone app.

Agent state must live on desktop / server:
- each browser action should be checkpointed
- steps should be idempotent and resumable
- app suspension must not kill the run
- mobile only observes, approves, resumes, or cancels

### Product synthesis
This adds two things to the mobile plan:

P1:
- draggable dual-surface split layout for Chat + Preview / Terminal / Review

P2:
- out-of-app agent status via Web Push first, native Live Activities later

Avoid:
- treating a paid/closed component page as code we can copy
- copying a fragile PiP/video rasterization hack before we have native app infrastructure
- allowing freeform split heights that create broken intermediate layouts
