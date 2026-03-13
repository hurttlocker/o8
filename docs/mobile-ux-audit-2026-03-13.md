# Mobile UX Audit — 2026-03-13

Author: Mister · Surface: `/mobile` · Device ref: iPhone 15 Pro (390×844)

---

## What's Working Well

These are legitimately good and should not be touched:

1. **The frosted glass language.** Every surface — compose dock, header, cards, overlays — uses the same `backdrop-filter: blur()` + rgba vocabulary. It feels cohesive and native to iOS.

2. **The compose dock animation system.** The CSS variable pipeline (`--remodex-dock-fade-progress`, `--remodex-compose-active`) gives the dock organic motion when scrolling and focusing. This is real craft.

3. **Message typography.** 1.08rem / 1.58 line-height for assistant messages is generous and readable. Code spans use the right monospace stack. The rich text renderer handles paragraphs, lists, headings, and inline code cleanly.

4. **The thread switcher pills.** The `repeat(auto-fit, minmax(0, 1fr))` grid adapts well. Labels are concise. Active pill gets a blue tint. Good.

5. **Controls sheet (new).** The vertical action list, status dots, and session checkmarks are clean. This is done.

6. **Diff viewer (new).** Dense code, stripped prefixes, subtle colors, file strip navigation. This is done.

---

## What I'd Change — Ranked by Impact

### P0 — Feels Wrong on iPhone

**1. User messages are white bubbles on a white background.**
The user turn (`.remodex-user-bubble`) is `rgba(255, 255, 255, 0.86)` on a page background that's essentially white (`#fbfcff` gradient). User messages don't visually separate from assistant messages. In iMessage, user messages are blue and right-aligned. In WhatsApp, they're green. Every native chat app gives the user's own messages a distinct treatment.

*Recommendation:* Make user bubbles a solid tinted color — `#2563eb` (the blue we're already using for Send) at like 8-10% alpha, or go full iMessage-blue with white text. They should be instantly distinguishable at a glance without reading.

**2. Assistant "working" messages are invisible.**
When Mister is processing (after Send, before response), there's no typing indicator or loading state in the message stream. The user taps Send, the textarea clears (good), and then... nothing visible happens until the response arrives. This is the #1 anxiety-inducing moment in any chat app.

*Recommendation:* Add a simple typing indicator — three animated dots in a small bubble, or a "Mister is thinking…" pill. Appears immediately on send, disappears when the first response chunk arrives.

**3. The system intro text is too long and too prominent.**
"Mirroring the live Q ↔ Mister conversation, not spawning a fresh session." — this is a 15-word developer explanation. It appears at the top of every view and takes meaningful vertical space. After the first read, it's pure noise.

*Recommendation:* Either collapse it to a single subtle line ("Live mirror") or remove it entirely. The "Live" pill already communicates the state. The explanation is documentation, not UI.

---

### P1 — Polish That Would Elevate It

**4. Timestamps are inconsistent and take too much space.**
"9:39 AM" / "11:02 AM" / "1:34 AM" — these appear as standalone centered lines between messages, consuming full rows. In iMessage, timestamps are inline or grouped (only shown when there's a time gap > 15 minutes).

*Recommendation:* Only show timestamps when there's a 15+ minute gap between messages. Show them as small, dimmed, centered text — not as full-row separators. Consider grouping consecutive same-speaker messages without repeating the "Assistant" / speaker label.

**5. The "Assistant" / "System" labels repeat on every message.**
Every assistant message shows "ASSISTANT" in the header. When you have 15 assistant messages in a row (like the current conversation), that's 15 identical labels adding no information.

*Recommendation:* Only show the speaker label on the first message in a consecutive run from the same speaker, or when the speaker changes. Collapse runs.

**6. The context pressure card duplicates information.**
Context pressure appears in TWO places: the floating header rail AND a full card in the scroll view. Both show "50% used · Stable". The header rail is the right place for glanceable status. The card is redundant.

*Recommendation:* Remove the in-scroll context card. Keep only the header rail. If you want more detail, let the rail tap into an expanded view.

**7. The "Copy message" button on every message is visually heavy.**
Every message has a "Copy message" button visible at all times. This is an occasional action treated as a primary one. On a phone screen, these buttons add visual clutter.

*Recommendation:* Hide copy buttons by default. Show them on long-press (iOS convention) or as a swipe action. Or show a single small icon that only appears on the most recent message.

**8. The bottom runtime bar (`openclaw · 43 files · feat/mobile-contr…`) is dense.**
Three chips with icons crammed into a small bar. On iPhone, this feels like a status bar competing with the actual iOS status bar and the compose dock above it.

*Recommendation:* Simplify to just the branch name (most useful info). The file count is in the diff pill already. The runtime label ("openclaw") adds nothing the user doesn't already know.

---

### P2 — Refinements

**9. Image attachments in messages don't have rounded corners matching the design language.**
The "Tap to expand" image buttons use the shared card style but may not have the same border-radius as other elements.

*Recommendation:* Ensure all image thumbnails use `border-radius: 16px` or similar, matching the overall card language.

**10. The Codex thread pills all look identical.**
Three pills all reading "Codex · cortex-ide • feat/m…" — the only differentiator is truncated off-screen. This was flagged in the controls audit too.

*Recommendation:* Show a differentiating detail — like the last activity time, or a 2-letter session hash, or the Codex status (running/idle/done). Something so you can tell them apart at a glance.

**11. No swipe-to-go-back gesture.**
Mobile Safari supports swipe-to-go-back, but since this is a single-page app, that gesture navigates away from the page entirely. There's no in-app back gesture to, say, go from a focused Codex session back to the main Mister view.

*Recommendation:* The thread switcher handles this, but consider a swipe gesture between sessions for faster navigation.

**12. The header hides on scroll-down but takes a long time to reappear.**
The scroll-aware header is a nice touch, but if the reveal delay is too long, users can't access the hamburger menu or diff pill quickly when they need it.

*Recommendation:* Ensure header reappears within 1-2 pixels of upward scroll, not after a threshold.

---

## Performance Issues (Observed)

| Endpoint | Avg Response Time | Target |
|----------|------------------|--------|
| `/api/mobile/inbox` | 12-25 seconds | < 2s |
| `/api/mobile/history` | 2.9 seconds | < 1s |
| `/api/mobile/review-file` | 1-3 seconds | < 500ms |
| `/mobile` (initial page load) | 12 seconds | < 3s |

The inbox endpoint is the bottleneck. It runs `gh` CLI commands (GitHub API calls) in series. These should be parallelized and/or cached aggressively. The page should render a skeleton immediately and hydrate as data arrives, not block on a 12-second endpoint before showing anything.

---

## Summary: What Ships vs. What Waits

### Ship now (same PR):
- P0 #1: User bubble tint
- P0 #3: Collapse system intro text
- P1 #5: Collapse consecutive speaker labels
- P1 #7: Hide copy buttons (show on tap/hover)
- P1 #8: Simplify runtime bar

### Ship next (follow-up PR):
- P0 #2: Typing indicator
- P1 #4: Smart timestamps
- P1 #6: Remove duplicate context card
- P2 #10: Differentiate Codex thread pills

### Backlog:
- Performance optimization (inbox endpoint caching, skeleton loading)
- Swipe gestures between sessions
- Image attachment corner radius audit
