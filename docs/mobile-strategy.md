# Mobile Strategy — Cortex IDE

> Superseded framing, 2026-05-24: active mobile product planning now lives in
> the native o8-mobile repo at
> `~/o8-mobile/docs/mobile-ui-pattern-notes.md`. Use that
> file for implementation targeting. This document is useful as older strategy
> context, but new mobile UX work should not be scoped as a dashboard/web app.

## Conclusion first

**Yes: mobile support should exist from day one.**

But not as “full IDE on a phone.”
The better architecture is:

- heavy work runs on desktop / server
- mobile is the remote operator surface

This is the key lesson from the Remodex thread and repo architecture.

## Why mobile matters early

Mobile still needs a **chat-first front door**.

A new user is more likely to understand a beautiful, fluent conversation surface first than a fleet dashboard.
So the mobile product should progressively reveal operator depth instead of leading with org complexity on first contact.

Multi-agent operation naturally creates moments where the operator is away from the desk but still needs to:

- approve a risky action
- unblock an agent
- inspect a failure
- steer a run
- review a PR summary
- see whether a job actually finished

If Cortex IDE is about controlling an agent organization, mobile is not optional for long.
It is part of the thesis.

## What the Remodex thread proves

The Remodex idea shows that:

1. a phone can be a highly useful controller for desktop agent runtimes
2. a local-first bridge plus paired mobile app is feasible
3. QR-based pairing is a strong onboarding flow
4. mobile can meaningfully support git status, diffs, notifications, and task watching
5. an open-source bridge can coexist with a managed relay / app distribution model

That is important because it means Cortex IDE does not need to invent a fantasy mobile story.
There is already a viable architecture pattern.

## Day-one mobile jobs

### Must-have jobs
- push notification when run completes / fails / blocks
- approve / deny requests
- pause / resume / kill agent
- send steer message
- inspect concise run summary
- inspect alerts and budgets
- search Cortex for related memory and prior fixes

### Strong early jobs
- view diff summary
- view PR queue
- read terminal tail / last logs
- switch between squads / agents
- jump to desktop deep link when needed

### Not day-one jobs
- full repo editing
- giant file navigation
- full IDE parity
- complex worktree manipulation from touch UI

## Recommended architecture

```text
[iOS App]
    <-> paired encrypted session / notification channel <->
[Cortex IDE control service]
    <-> runtime adapters / Cortex / GitHub / artifacts
```

### Pairing flow
1. Desktop creates device session
2. User scans QR with mobile app
3. Mobile and control plane establish trust
4. App subscribes to operator-safe event stream
5. Quick actions become available immediately

### Transport model
Use a secure relay-capable architecture:
- local-first where possible
- relay only when needed
- end-to-end encrypted payloads for operator actions and sensitive state

## Cortex-specific mobile advantage

Cortex makes mobile dramatically more useful than a dumb remote-control app.

Instead of just seeing “Agent failed,” the phone can show:

- last task summary
- relevant prior incidents
- learned fix patterns
- repo / branch / PR context
- memory-backed suggested next actions

That turns mobile from a pager into a real operating console.

## Mobile information hierarchy

### Tier 1 — immediate action
- run failed
- approval requested
- budget exceeded
- high-severity alert

### Tier 2 — important state
- run complete
- review ready
- blocker cleared
- PR opened

### Tier 3 — passive awareness
- squad throughput
- daily summaries
- memory health trends

## UI recommendation

Mobile UI should optimize for:

- fast glanceability
- one-handed actions
- obvious severity
- minimal typing when possible
- deep linking to desktop when the task is too complex

Suggested tabs:
- **Inbox** — approvals, alerts, reviews
- **Fleet** — agents and squads
- **Runs** — active and recent work
- **Memory** — Cortex search and incident recall
- **Account** — device pairing, permissions, settings

## Product recommendation

### For v0
Ship mobile as a thin but real operator companion.

### For later
Expand into:
- voice steering
- richer diff review
- mobile-first incident response
- background watch modes
- wearable / notification-only quick actions

## Locked research-informed plan — May 24, 2026

Recent product references sharpen the plan:

- Notion mobile refresh: borrow softness, floating input, calm cards, and selective density.
- Paulius / Komand demos: mobile must close the AFK agent loop with live preview, review, approval, and commit.
- `AI-experiments`: borrow prompt navigation, answer-depth controls, and tactile AI steering patterns.
- `ShipSwift`: borrow the idea of a reusable, tuneable motion/theme layer, especially for subtle paper/ink movement behind chat.

### P0 build targets
- persistent floating orchestrator composer
- persistent agent state pill synced from desktop/runtime state
- switchable mobile surfaces for Chat / Files / Review / Terminal / Browser / Preview
- full-screen preview surface for tunneled localhost URLs
- preview lifecycle states: loading, ready, stale, crashed, disconnected

### P1 build targets
- mobile review sheet with changed-file list and compact diff
- AI-generated commit message from the review sheet
- draggable dual-surface split layout for Chat + Preview / Terminal / Review
- prompt/history navigator for long orchestrator chats
- answer-depth control for summaries, diffs, and explanations
- subtle paper-motion background behind chat

### P2 build targets
- Expo / React Native preview bridge
- remote simulator streaming investigation
- out-of-app agent status via Web Push first, native Live Activities / Dynamic Island later
- camera/context capture for bug reports and visual AI context
- memory/topic map inspired by node/globe interaction experiments

### Motion theming rule
Mobile chat may have motion, but it must stay quiet.

The target is paper grain, slow ink, or soft texture behind the conversation.
It should be token-driven, low contrast, and easy to disable.

Do not use loud plasma/chrome effects, decorative orbs, or heavy gradients as the primary chat background.
Terminal, review, diff, and code surfaces should either disable the motion layer or reduce it to near-invisible texture.

Implementation should start in the current web mobile surface:
- CSS or Canvas grain first
- `framer-motion` for theme/intensity transitions
- `prefers-reduced-motion` support
- one `MobileMotionTheme` registry instead of scattered background code

Native SwiftUI references from `AI-experiments` and `ShipSwift` can be reused later in `o8-mobile` with MIT attribution if the native path becomes the active target.

### Draggable split-surface rule
Mobile should support a controlled split layout for work that needs two simultaneous surfaces.

Start with these pairings:
- Chat + Preview
- Chat + Terminal tail
- Review summary + Diff
- Agent status + Browser preview

The split layout should have three rest states only:
- compact top
- balanced
- compact bottom

During drag, low-priority controls should fade or compress before clipping.
When a pane is too small, it should switch to a compact summary rather than showing broken full UI.
The user's last split ratio should persist per surface pair.

For the current web mobile app, implement this with pointer events, CSS variables, and `framer-motion`.
For a future native app, React Native Reanimated plus Gesture Handler is the right model.

### Background status rule
Out-of-app agent visibility is useful, but the phone should never own the run.

Desktop/server execution remains authoritative.
Mobile receives progress, status, and approval requests.
If the app is suspended, the agent must continue safely.

Current web path:
- push notifications
- service worker status updates where available
- resume-to-current-state when the user reopens the app

Native future:
- Live Activities / Dynamic Island first
- Picture-in-Picture video only as a research path, not the default implementation

## Strategic payoff

If Cortex IDE supports desktop + mobile from the start, it becomes more than an editor idea.
It becomes a genuine **operating system for agent work**.
