# Clicky Competitive Dossier — what Symon borrows to beat HeyClicky + OpenClicky

*2026-06-10. Sources: UGC video analysis of @heyclicky demos, HeyClicky site/YC profile,
farzaa/clicky open-source repo, jasonkneen/openclicky repo + X posts, Isaac Flath's
"How Clicky Works" deep-dive. Full research citations at the bottom.*

> **Status (2026-06-10): BUILT.** Tier 1 #1–#4 and Tier 2 #5/#6/#8 shipped
> (#7 tours ride the Points protocol; #6 was already satisfied by the chunked
> TTS lead-chunk). #9 AirPods gestures + #10 skills stay parked. Architecture
> notes: [`symon-presence.md`](./symon-presence.md).

**The frame:** HeyClicky (YC S26, closed-source, consumer-polished) and OpenClicky
(open-source, power-user, architecturally stronger) are the two reference points for
voice-first Mac agents. Symon already beats both on **governance** (confirm cards,
safety classes, sandboxed writes — neither has ANY approval surface) and on the
**o8 bridge** (neither can dispatch a coding fleet). What they have that we don't is
**presence on the screen**: pointing, motion, and zero-friction file context.

We keep the glass. Everything below is expressed in Symon's design language —
translucent dock, spring curves, flow and continuation — never Material, never theirs.

---

## What they are (one paragraph each)

**HeyClicky** — menu-bar voice assistant that *sees the screen* and *points at it*.
Hold Ctrl+Option, ask "where do I click?", and a glowing triangle swoops across the
screen to the answer while TTS talks. Say "clicky agent" and it spawns background
workers that click through apps (Notion, Calendar, Linear, Gmail, Reminders). Free,
closed-source, consumer-zero-setup. Its magic is the *pointer* — the AI shares your
screen instead of living in a chat box.

**OpenClicky** — Jason Kneen's open-source answer, native Swift. Same pointing overlay,
but with a real agent architecture: a **routing hierarchy** (direct answer → web search
→ child worker → integration API → computer-use clicking *only as last resort*),
spawnable child workers, a skills system (SOUL.md files), persistent memory with
self-fixing, and a local HTTP bridge (port 32123) so *other* agents can drive its
screen tools. Faster than HeyClicky per its author; "liquid glass" theme — they're
converging on OUR aesthetic.

## Scorecard — where Symon stands today

| Capability | HeyClicky | OpenClicky | Symon (o8) |
|---|---|---|---|
| Voice push-to-talk + TTS | yes | yes | **yes** (Option hold, Fn dictation) |
| Screen comprehension | yes (live) | yes | partial (Ask lane has screen context; agent lane does not) |
| **Pointing at the screen** | yes — the signature | yes (+multi-marker tours) | **no** |
| Open/control apps | yes | yes | **yes** (open_app fuzzy, native tools) |
| Native structured tools (EventKit/AppleScript first) | partial | **yes (routing hierarchy)** | **yes** — we already do API-before-GUI |
| Background/child workers | yes ("clicky agent") | yes (sessions_spawn) | **yes and stronger** — o8_dispatch into governed worktrees |
| Approval/confirm surface | **none** | **none** | **yes** — confirm cards, safety classes |
| Drag files into the agent | **yes** (their newest demo) | partial | **no** |
| Memory / self-learning | no | yes (SOUL.md, self-fix) | **yes** (Cortex v2) — but not surfaced in Symon's UX |
| External-agent control bridge | no | yes (HTTP 32123) | **yes** (operator MCP) — ours is two-way and governed |
| Extensibility | none | skills system | code-level only |

Read that table honestly: we win the *trust* and *infrastructure* rows; they win the
*presence* rows. Presence is what demos well and what users call magical.

---

## The build list — ranked to beat both

### Tier 1 — the moat-makers (do these)

**1. The pointing overlay (Symon Points).** One transparent, click-through NSPanel
per monitor, floating above everything. The model emits `[POINT:x,y:label:screenN]`
tags inline in its text (LLM-native, no tool-call overhead — proven by both Clickys);
we parse and animate. **Our glyph is not their triangle**: a soft glass dot with the
o8 orange ring, trailing a subtle blur — Rams, not gamer. Flight path: quadratic
Bézier with a lifted midpoint (the "swoop"), rotation following the travel direction,
spring landing (`stiffness: 400, damping: 30` — house curve). This single feature
closes the only gap users would call magical, and it composes with everything below.
*Hidden complexity to budget: the three-axis coordinate transform (screenshot px →
display points → panel coords, Y-flip, per-monitor origins, Retina scale). The o8
webview MCP tools hit this exact class of bug (#1105) — same lesson applies.*

**2. Screen context in the AGENT lane.** Today only the (now key-unbound) Ask lane
sees the screen. Fold a screenshot grab into `agent_run` when the prompt references
the screen ("what's this error", "click… where is…"), so the ONE Option gesture
handles guidance questions too. Gate it: screen capture only when the intent needs it
(privacy + tokens). This + pointing = full HeyClicky interactive-mode parity inside
our governed loop.

**3. Drag-files-into-Symon (from their newest demo).** Drag any Finder file toward
the dock: the sliver morphs into a glass drop zone, file lands as a chip, the zone
*continues* into the composer with the chips attached — one motion, no modal. Their
version is a black rectangle; ours is the existing dock morph vocabulary (capsule →
answer panel → confirm card already flow into each other — this is one more state).
Wire dropped paths into the agent as context (`fs_read_text` / `csv_read` candidates,
sandbox rules unchanged).

**4. Surface the memory we already have.** OpenClicky markets "self-learning."
Cortex v2 is *deeper* than their SOUL.md files but invisible in Symon's UX. When a
session outcome or directive informs an answer, the dock shows a quiet "remembered"
glint (one line, fades). When the agent recovers from a failed approach, say so in
the spoken reply ("trying a different way — last time X failed"). Zero new
infrastructure; pure surfacing. This converts our moat into *felt* product.

### Tier 2 — strong follows

**5. Routing hierarchy, stated and enforced.** We already do API-before-GUI by
construction (EventKit/AppleScript tools, no screen-clicking at all). When we add
computer-use (clicking) later, adopt OpenClicky's explicit ladder: structured tool →
web → child worker → **point** (show the human where to click) → click-for-them as
the LAST rung, always behind a confirm card. Pointing-before-clicking is both safer
and more Symon: teach, don't snatch the mouse.

**6. Live transcription + streamed response interleave.** Both Clickys stream STT
live and start TTS before the full answer lands. Our dock already shows live
partials while recording; extend the *response* side: begin speaking the first
sentence while the rest streams into the answer panel. Perceived latency is the whole
ballgame in voice UX.

**7. Multi-marker screen tours.** OpenClicky's `screen-tour` skill: several labeled
points at once with captions ("this field, then this button"). Natural extension of
the pointing overlay (#1) — same panel, array of `[POINT]` tags, staggered spring-in
(120ms cadence) so the tour *flows* point to point. Killer for "walk me through this
app" asks.

**8. Background-worker status in the dock.** When `o8_dispatch` (or a future local
child worker) is running, the dock sliver carries a slow orbiting dot (we already
have the o8 orbit motion from the Synthesizing card) + count. Tap → status capsule.
HeyClicky's agents are invisible-until-done; OURS are governed AND visible — that
contrast is marketing.

### Tier 3 — selective / later

**9. AirPods nod/shake to resolve confirm cards.** OpenClicky has head-gesture
confirmation. We have an actual confirm surface to attach it to — nod = Allow,
shake = Cancel, with the card pulsing once on registration. Differentiated and
genuinely useful hands-free; needs the motion-API plumbing, so park it behind Tier 1.

**10. Skills/extensibility.** OpenClicky's SOUL.md skill files are their
extensibility story. Ours should NOT be loose prompt files — when the time comes,
skills are *governed packages* (operator-approved, versioned, listed in settings).
Don't rush this; tool quality beats tool quantity at our stage.

**Explicitly NOT borrowing:** their chat-window-first layouts (our dock is the
surface), the cartoon pointer glyph, pets/gamification (OpenClicky's — off-brand for
the eight-hour-legibility lens), and ungoverned autonomous clicking (HeyClicky agents
act with zero approval surface — that's the gap we *attack*, not copy).

---

## The one-line strategy

They built a pointer with an assistant attached; we built a governed agent with no
pointer. Add presence (point, see, receive files, show memory) to Symon's existing
trust architecture and there is no remaining reason to choose either Clicky.

## Suggested sequencing

1. **#1 + #2 together** (overlay + agent-lane screen context) — one epic, the
   pointing demo falls out of it.
2. **#3** (drag-to-dock) — small, self-contained, instantly demoable.
3. **#4** (memory surfacing) — UI-only, can ride any ship.
4. **#6, #7, #8** as polish waves; **#5** codified when computer-use lands; **#9/#10** parked.

## Sources

- HeyClicky: heyclicky.com · YC profile (ycombinator.com/companies/heyclicky) · @heyclicky drag-files demo (x.com/heyclicky/status/2064520227455705579, UGC analysis saved at `~/UGC/data/analyses/heyclicky-agent-interaction.json`)
- Clicky OSS: github.com/farzaa/clicky · Isaac Flath, "How Clicky Works" (isaacflath.com/writing/how-clicky-works) — the coordinate-transform + Bézier flight reference
- OpenClicky: github.com/jasonkneen/openclicky · @jasonkneen X posts on routing/widgets/liquid-glass (x.com/jasonkneen/status/2060252173846688147, /2057136419068416005)
