# Symon presence layer — Points, screen context, drop staging, glints, worker pulse

*Shipped 2026-06-10 from the Clicky competitive dossier (`clicky-competitive-dossier.md`).
Tier 1 #1–#4 and Tier 2 #5/#6/#8 are live; #7 (tours) ships inside the Points
protocol; #9 (AirPods gestures) and #10 (skills) stay parked.*

## Symon Points (`[POINT:x,y:label]`)

The agent model points at the user's screen by emitting tags inline in its
reply — LLM-native, no tool-call overhead:

```
[POINT:x,y:label]            x,y in SCREENSHOT pixels, label 1-3 words
[POINT:x,y:label:screenN]    screen suffix accepted, ignored in v1
```

- **Parse + strip**: `point_overlay::parse_point_tags` removes tags before the
  text is stored, displayed, or spoken — garbage never reaches TTS.
- **Overlay window**: label `point-overlay` (third window; never `main`, never
  `dock`), transparent, **click-through** (`set_ignore_cursor_events(true)`),
  level 25, nonactivating, lazy-created over the captured monitor, auto-hides
  (8s + 2.5s per extra point, cap 20s; generation counter guards stale timers).
  Capability: `src-tauri/capabilities/point-overlay.json` (events only).
- **Coordinate transform** (the #1105 bug class, centralized in ONE place —
  `point_overlay::show_points`): screenshot px → monitor logical points →
  window-local coords. The capture records image dims + monitor bounds.
- **Glyph** (`src/app/point-overlay/page.tsx`): soft glass dot + o8 orange ring
  (`#FF5A1F`), NOT a cartoon triangle. Single point flies a quadratic Bézier
  with a lifted midpoint (CSS `offset-path`, rotation follows travel), lands
  with a spring overshoot + one ring ripple, label chip fades in. 2+ points =
  a tour: numbered markers spring in staggered 120ms.
- **Events**: `o8:point-show` `{gen, points, tour, durationMs}` /
  `o8:point-hide` (fade, then window hides). A new agent task hides stale
  pointers immediately.

## Screen context in the agent lane

`agent/screen.rs` — intent-gated: only prompts that talk about the screen
("what's this error", "where do I click", "point to…", see `SCREEN_CUES`) pay
the capture. `screencapture` + `sips` (no image crates), monitor under the
cursor, downscaled to ≤1440px, base64 PNG as Gemini `inline_data` on the first
turn, plus the POINT teaching section in the prompt. First capture triggers
macOS's one-time Screen Recording grant for o8.

## Drag-files-into-Symon

Native HTML5 DOM drops (the Tauri DragDrop bridge stays disabled — see the
dragDropEnabled macOS trap). `useDockFileDrop` listens at document level in
the dock webview; the sliver morphs into a glass drop zone (soft inner orange
ring), the drop lands as chips ("Staged — hold ⌥ and ask"), and bounded text
excerpts (48KB/file, 160KB total, 5 files) stage via `agent_files_stage` into
the next `agent_run` prompt (5-min TTL). WKWebView exposes content, not paths
— so content travels; sandbox rules unchanged.

## Memory glints

Both agent loops record `ok` per tool call in the ledger. The reply path
derives:

- **recovered** — a failed tool followed by a later success → "Recovered —
  found another way" (and the system prompt asks Symon to narrate the recovery
  aloud);
- **remembered** — the answer drew on the Engineering Brain (`o8_ask`) →
  "Remembered".

One quiet uppercase chip under the dock (`kind: "glint"` on
`o8:agent-task-event`), fades in, holds ~4s, fades. Pure surfacing of Cortex —
zero new infrastructure.

## Worker pulse

`agent/worker_pulse.rs` polls `/api/lanes?active=true` (30s in flight / 90s
quiet; `o8_dispatch` nudges an immediate poll) and emits `o8:worker-status`
`{count, repos}`. The resting sliver carries the slow orbit + count (dark ink
on the light sliver); tapping it expands a transient capsule naming the
in-flight repos. HeyClicky's background agents are invisible-until-done; ours
are governed AND visible.

## Routing doctrine (in the system prompt)

Structured native tool → `o8_ask` for code/fleet knowledge → `o8_dispatch`
when the work changes a repo → POINT to teach (Symon cannot click for the
user) → say plainly what's missing. Pointing-before-clicking is both safer and
more Symon: teach, don't snatch the mouse. If computer-use clicking ever
lands, it goes BEHIND the confirm card as the last rung.

## Voice latency

TTS was already first-sentence-fast (dossier #6): `tts/playback.rs` splits on
sentence boundaries with a short ~200-char lead chunk (~1-2s to first audio)
and a one-chunk lookahead — the aqua `reading.rs` port. Agent replies are
prompted to one or two sentences, so the lead chunk usually IS the reply.
