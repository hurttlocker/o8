# Live OpenClaw Bridge — Session Model Decision

## Decision

The first live OpenClaw integration in Cortex IDE should **mirror existing sessions first**.
It should **not** create a brand-new session automatically just because the app opened.

## Why

Auto-spawning a session from the UI would blur the operator model:
- fake work appears without intent
- context splits across ghost sessions
- the desktop shell stops reflecting reality
- Q cannot trust whether he is looking at the live lane or a duplicate

That is the wrong shape for a command center.

## First live behavior

### Default
- pin the current primary session first
- for Mister/Q this is the direct lane: `agent:main:main`
- show other visible OpenClaw sessions underneath it

### Explicitly not default
- do not auto-spawn a new run on load
- do not fork the current chat into a hidden session
- do not create a new coding lane just because a panel mounted

## Product rule

### Mirror first
The shell should answer:
- what is OpenClaw doing right now?
- what session am I already in?
- what other active surfaces exist?
- what can I inspect before I decide to spawn something new?

### Spawn later
Spawning is still important, but it belongs behind an explicit action:
- Spawn agent
- New task
- Fork lane
- Create review run

## Current implementation path

### Data source
Use:
- `openclaw status --json`

### First mapped surfaces
- current direct session
- direct agent sessions
- group/channel surfaces
- cron / automation surfaces

### UI consequence
- desktop shell = live inventory + inspector
- mobile shell = primary mirrored session + quick surface list
- both explain that current mode is **mirroring existing sessions first**
- explicit runtime control is allowed only when it stays truthful:
  - inspect transcript via `chat.history`
  - steer the selected live session via `chat.send`
  - interrupt the selected live session via `chat.abort`

## Guardrail

If the app opens and silently creates a new session, that is drift.
If the app opens and shows the same live session Q is already in, that is aligned.
