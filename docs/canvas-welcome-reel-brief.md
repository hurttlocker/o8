# Brief: o8 Canvas "Welcome Reel" — Paper Aurora

**For: Claude Design.** Build a short, looping, cinematic **welcome reel** that plays in the right-hand pane of o8's first-run welcome modal. Keep the **Paper Aurora** aesthetic described below, but take the graphics and motion far past what a CSS prototype can do. This is the first thing a new operator sees — it should feel like the opening of a flagship product.

---

## What o8 is (context)

o8 is the **control plane for autonomous engineering teams** — a desktop app where one operator directs a fleet of AI coding agents. The **Canvas** is its spatial command surface: an infinite, zoomable glass board where you talk to an orchestrator, drop in work, watch agents build in parallel, review their diffs, and ship — every move in view, every merge yours to call. Design language: Steve Jobs polish, Dieter Rams restraint, calm confidence. One accent color. Nothing gratuitous.

The reel's job: open on the line **"The control plane for your agents,"** then move through what the Canvas can do — ending back on the wordmark. Premium, quiet, inevitable.

---

## Placement & format

- **Lives in:** the right pane of a horizontal split card (the left pane is dark and carries the headline "Welcome to a shift in momentum." + a Start button — you are ONLY making the right pane).
- **Orientation:** landscape rectangle, aspect **~1.28:1** (e.g. design at **1280×1000 @2x**, displays ~410×320 logical). The **top-right and bottom-right corners are rounded (22px)**; the **left edge is a straight vertical seam** against the dark pane. Don't round the left corners.
- **Loop:** seamless, **12–16s**, no visible cut.
- **Two tone variants (required):** **Paper** (light, primary) and **Slate** (dark). The app flips between them with the user's theme.

### Deliverable (pick the higher-fidelity path you can)
1. **Preferred — rendered video per tone:** two seamless loops, `welcome-reel-paper.webm` + `welcome-reel-slate.webm` (VP9/alpha if you can, else mp4). We embed as `<video autoplay loop muted playsinline>`. Render however you like — Remotion's *renderer*, After Effects, WebGL capture. Go wild on graphics here.
2. **Fallback — self-contained React component:** `tone: 'light' | 'dark'` prop; **framer-motion / CSS / WebGL only**; **inline styles only (no CSS classes — hard rule in our codebase)**; no Remotion `<Player>` (it will not advance frames in our embedded WebKit — confirmed). Must loop on its own clock.

---

## The "Paper Aurora" look (keep this)

- **Paper ground:** warm off-white gradient, `#f8f8f6 → #ececea`, 155°. Like premium matte paper. (Slate variant: `#202430 → #14171f`.)
- **Aurora:** large, heavily-blurred radial color washes drifting **slowly** behind the content — a warm **orange**, a periwinkle **violet**, a soft mint **teal**. Low opacity on Paper (dreamy, barely-there); a touch more luminous on Slate (they glow). This is the soul of the piece — make the drift feel alive and physical, not a looping gif. Think volumetric light, gentle parallax, subtle grain.
- **Dotted grid:** a faint dot-matrix (the Canvas signature), radially masked so it fades toward the edges. Keep it whisper-quiet.
- **Wordmark:** lowercase **`o8`** persistent in the **top-left**, 22px, weight 500, ink color. Always visible.
- **Ink:** `#16181d` on Paper / `#f4f5f7` on Slate. **Accent:** a single o8 orange `#FF5A1F`, used sparingly (the beat glyph, the active progress dot). Never a second accent.
- **Type:** system sans (SF Pro / Inter), weight 500, tight tracking (~-0.03em). Hero line ~32px, capability lines ~27px (logical).
- **Progress dots:** a row at the bottom-center, one per beat; the active one elongates into an orange pill. (The reel is a "tour" — the dots tell you how far through.)

**The bar:** what's there now is a flat CSS prototype — paper + three blurred blobs + crossfading text. You should make it feel *expensive*: real depth, layered parallax, light that moves, glass cards that drift in 3D space behind the text, micro-motion on every beat, a specular sheen that tracks the aurora. Cinematic easing, never linear. Calm, not busy.

---

## The script (beats)

Open on the hero, move through the capabilities, return to the wordmark. Each beat: a **clean 2px line glyph** + a **short line**, entering on a soft rise and crossfading out. Hold the hero a beat longer.

1. **Hero** — `The control plane for your agents.`  *(glyph: three connected nodes)*
2. `Talk to the orchestrator.`  *(glyph: chat bubble)*
3. `Drop anything on the canvas.`  *(glyph: stacked cards; optional small caption: "images · video · files · terminals · browsers")*
4. `Agents build in parallel.`  *(glyph: fan-out / worktrees)*
5. `Ask the Brain — cited, instant.`  *(glyph: spark / brain)*
6. `Review every diff.`  *(glyph: diff marks)*
7. `Ship on your approval.`  *(glyph: check)*
8. **Close** — return to the `o8` mark, large and centered, with `The control plane for your agents.` beneath, then loop.

(Optional 9th if it fits the rhythm: `Drive it by voice.` — glyph: waveform.)

You may visualize each beat literally if you can do it tastefully — e.g. beat 3 shows tiny glass cards (a photo, a video clip, a terminal, a browser) drifting onto the board; beat 4 shows one node fanning into several; beat 6 shows a diff gutter; beat 7 a single approving check. But the text + aurora alone, done beautifully, is enough. Restraint wins.

---

## Full capability menu (so you understand the product depth)

The Canvas is the operator's whole surface. It can:

- **Orchestrate** — talk to an orchestrator (Claude) scoped to a repo; it dispatches and supervises agents.
- **Mode** — Fleet orchestration (dispatch sub-agents in isolated git worktrees), Single agent (solo, no dispatch), Fusion (deep multi-agent pass).
- **Run agents in parallel** — Codex/Claude workers build simultaneously in isolated worktrees; watch their output, tool calls, and status stream live.
- **Drop & spawn cards** — image cards (reference/inspiration), video cards (UI clips), file cards (rendered markdown), live terminal cards, agent-driven **browser** cards ("Agent Chrome"), diff/worktree review cards, o8.md spec cards, floating orchestrator chat cards (dock/undock), and Engineering-Brain cards.
- **Engineering Brain (Cortex)** — ask anything about the repo and get **cited** answers from organizational memory; works on screen, by voice, and for the agents themselves.
- **Review & govern** — see every diff, then approve-and-merge; **nothing ships without the operator**. This is the moat: governance + organizational memory + the approval surface.
- **Voice (Symon)** — talk to o8, push-to-talk dictation, ask the Brain out loud.
- **Resurface** — past sessions return as draggable boxes; search across cards + sessions.
- **Scale** — multi-repo / fleet scoping; mobile remote control; Paper/Slate theming.

Distill, don't dump — the reel shows the *feeling* of command, not a feature list. The menu above is for your understanding of what's true.

---

## Reference note — the motion is a layer, not a shader (verified frame-by-frame)

The operator's reference (their product's sign-in) does NOT use a full-screen shader. It's a **static photo background + one organic element (a butterfly) animating across on a slow flight path, passing BEHIND the frosted glass card** (the card's backdrop-blur frosts it as it crosses — that's the premium tell). Likely **Rive or Lottie** (vector creature + wing-flap state + path), or a small alpha video. There may be a faint ambient light drift too, but the crossing element is the hero motion.

Apply the *principle*, not the literal butterfly: o8 is a control plane, not a nature app. Give the right pane a subtle element drifting **behind the glass** — an o8 motif (a soft drifting light, a slow-moving node/spark, a faint glass card gliding past) — frosted by the panel as it passes. Keep it whisper-subtle and slow. The Paper Aurora washes can remain as the ambient ground; this adds one tasteful moving layer on top, behind the glass.

## Voice & acceptance

- **Voice:** first-person-plural confidence, plain and concrete. No hype words, no exclamation, no emoji. The lines above are close to final — tighten, don't inflate.
- **Done looks like:** a loop you'd put on the homepage. Premium motion, real depth, the Paper Aurora intact, both tone variants, seamless, and it reads in ~2 seconds per beat at a glance. If a senior Apple designer would ship it as a product intro, it's right.
