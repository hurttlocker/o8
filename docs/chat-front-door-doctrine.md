# Chat-First Front Door Doctrine — o8

## One-line thesis

**Cortex IDE should feel like a fluent, beautiful AI chat product on first contact, then progressively reveal itself as an agent command center.**

This is the product-shape correction that keeps the chat page sacred while still letting the repo grow into the Karpathy-scale IDE-for-agents vision.

## Why this doctrine exists

Two truths are both real:

1. Most new users will enter through **chat**, not through fleet orchestration.
2. The product is incomplete if it never grows beyond chat into **runtime control, review, memory, and org operations**.

The mistake would be choosing one truth and killing the other.

Cortex IDE should not force a false choice between:
- a beautiful consumer-legible chat product
- an advanced multi-agent command center

The right answer is **progressive disclosure**.

## Product shape

### Layer 1 — Chat
This is the front door.

It must be:
- beautiful
- fluent
- familiar
- emotionally legible
- trustworthy for a ChatGPT-shaped user

The chat page is not a placeholder while we wait to build the “real” product.
It is the first abstraction users understand.

### Layer 2 — Review / evidence
Once a user wants more than plain chat, the next layer is:
- diffs
- artifacts
- repo truth
- context pressure
- review posture

This is where the product starts to feel more capable without becoming hostile.

### Layer 3 — Runtime surfaces
Only after the user wants deeper control should the product open:
- terminal tail
- runtime state
- bounded input
- interrupt / stop
- linked diff / review context

This layer should feel like entering a deeper chamber inside the same product, not switching to a different app.

### Layer 4 — Org control
At the deepest layer, Cortex IDE becomes the command center:
- multiple agents
- fleet views
- approvals
- policy
- memory / provenance / replay
- saved operating layouts

This is the house behind the welcome mat.

## Non-negotiable product rules

### 1. Protect the chat page
Do not let deeper runtime work degrade the chat front door.

That means:
- do not turn the first page into an ops dashboard
- do not center the default mobile surface on raw terminal mechanics
- do not lead with multi-agent complexity before trust exists

### 2. Keep one design language
The current focused mobile chat page is the live reference template for future product surfaces.

Future runtime, review, and control layers should borrow its:
- restraint
- warmth
- light-blue glass language
- floating chrome behavior
- truthful status styling
- premium-but-not-noisy hierarchy

Do not let deeper operator surfaces drift into a colder, uglier, “admin shell” language.

### 3. Truthfulness beats implication
If a capability is not real, the UI must not imply that it is.

Examples:
- no fake approvals
- no pretend pause/resume
- no “terminal” label for a glorified transcript
- no mobile control that bypasses real runtime semantics

### 4. Chat remains a valid stopping point
A user should be able to stay in chat and never feel punished for not going deeper.

Deeper layers are there when the user wants them.
They are not the price of entry.

### 5. Runtime depth must feel “inside something”
The user correction here is important:
- if you want to get deep enough to reach terminal/runtime, you can
- if you want to stay in chat, you can

That means terminal/runtime depth should open from within the product via:
- drawers
- bottom sheets
- inspect panels
- focused runtime tabs
- contextual “open live surface” actions

Not via a total page identity swap.

## RuntimeSurface / TerminalSession doctrine

The bounded **RuntimeSurface / TerminalSession** layer is now in place.

Its purpose is to bring real execution surfaces into Cortex IDE without making the UI runtime-vendor-specific.

### What it should normalize
- attach
- read tail
- send input
- interrupt
- resize
- open diff / review context
- surface artifacts and linked repo state

### What the UI should see
The UI should not reason directly in terms of “OpenClaw vs Codex vs Claude Code” wherever possible.
It should reason in terms of a truthful runtime surface.

Example shape:

```ts
export interface RuntimeSurface {
  id: string;
  runtime: 'openclaw' | 'codex' | 'claude_code' | string;
  title: string;
  cwd?: string;
  branch?: string;
  status: 'running' | 'idle' | 'blocked' | 'exited' | 'unknown';
  sessionKey?: string;
  reviewContext?: {
    repoSlug?: string;
    branch?: string;
    pullRequestUrl?: string;
  };
  capabilities: {
    attach: boolean;
    readTail: boolean;
    sendInput: boolean;
    interrupt: boolean;
    resize: boolean;
    diffContext: boolean;
    reviewContext: boolean;
  };
}
```

### What the UI must not assume
- that every runtime supports PTY attach
- that every runtime supports send-input
- that pause/resume exist
- that every session is safe to mutate from phone

Capabilities must remain explicit.

## First supported surfaces

### 1. OpenClaw-backed sessions
These already have the cleanest truth surface in the current stack.

### 2. Codex-backed sessions
This is the right next expansion because it brings real live work that currently happens outside the IDE into the control plane.

## Codex stance

### What we should do first
Support **owned or attachable Codex sessions** with stable metadata.

That means the first Codex lane should focus on:
- discovery
- attach / inspect
- tailing output
- bounded input
- interrupt
- linking runtime state to repo / review context

### What we should not do first
Do **not** start by trying to hijack arbitrary Terminal.app or iTerm windows as a general remote-control stunt.

Why:
- brittle
- app-specific
- weak abstraction
- weak security story
- high maintenance burden

The first version should be a truthful control-plane integration, not desktop automation cosplay.

## Why the Codex attach spike is real, not theoretical

Live local inspection on this machine already shows:

- active `codex` CLI processes are running right now
- Codex persists session/event material under `~/.codex/sessions/YYYY/MM/...jsonl`
- Codex persists thread/session metadata in `~/.codex/state_5.sqlite`
- the `threads` table already contains useful fields like:
  - `id`
  - `cwd`
  - `title`
  - `git_branch`
  - `git_sha`
  - `updated_at`

That means the first Codex runtime spike can be grounded in a real local metadata surface instead of guesswork.

## Implementation doctrine

### Phase 1 — Lock the doctrine into the repo
Write the principle down once so future UI/runtime work does not accidentally bulldoze the front door.

### Phase 2 — Define the RuntimeSurface contract
Add a product-facing contract above adapter-specific implementation details.

This should clarify:
- surface identity
- capabilities
- attach semantics
- terminal-tail semantics
- input / interrupt truth
- review / artifact linking

### Phase 3 — Desktop-first runtime entry
Add runtime depth on desktop first.

The right initial surface is not a separate app mode.
It is a contextual runtime drawer/panel from the selected agent/session.

Desktop must prove:
- discoverable entry
- live tail readability
- bounded input
- interrupt
- linked diff / review context

### Phase 4 — Codex session discovery + attach spike
Build a bounded spike that can:
- discover live/known Codex sessions
- map them into `RuntimeSurface`
- read tail / recent output truthfully
- identify repo / branch / cwd when available

If input/interrupt semantics are clean, add them.
If not, keep the spike read-focused first.

### Phase 5 — Mobile watch/intervene
Only after desktop runtime surfaces feel real should mobile expose the smaller control subset:
- watch tail
- inspect state
- send bounded input
- interrupt
- jump to desktop when the task is too deep

## UX rules for runtime depth

### Good
- open runtime inside a drawer, tab, or inspect surface
- let chat remain visible or easily recoverable
- maintain the same visual grammar as the chat surface
- show only the controls that are truly available

### Bad
- replace the chat page with terminal chrome
- dump raw runtime internals on first contact
- make the product feel like a debugger before it feels like a product
- let a vendor-specific runtime define the UI model

## Success bar

We should know this doctrine is working when both of these are true:

1. A new user can arrive and think:
   - “this is a beautiful, familiar AI product I can talk to”

2. A power user can go deeper and think:
   - “this is the place I supervise real agent work, terminals, review, memory, and runtime truth”

That is the wedge.
Not chat alone.
Not ops alone.
Both, in the right order.
