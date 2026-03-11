# Remodex / Phodex Integration Plan

## Why this lane exists

The Remodex project is currently the clearest open-source reference for:
- iPhone remote control of a desktop coding runtime
- QR pairing
- bridge + relay architecture
- local-first execution with mobile supervision

That maps directly onto the Cortex IDE mobile thesis.

## License / adoption stance

Remodex is currently published with an **ISC** license, which is permissive enough for private internal adoption and derivative implementation.

## Recommendation

### Do not do
- do not make Cortex IDE a thin rebrand of Remodex
- do not let Codex-specific assumptions leak into the whole product

### Do do
- use Remodex as the bootstrap architecture for the **mobile remote-control lane**
- privately fork or vendor the relevant bridge concepts if needed
- generalize the protocol around Cortex IDE’s own control service

## What to reuse conceptually

### Pairing
- QR bootstrap
- device identity
- trust establishment

### Transport
- relay-capable secure channel
- reconnect logic
- event streaming

### Mobile jobs
- approval prompts
- run completion notifications
- quick steering
- git / diff skim
- thread / run watch

## What to replace

### Replace Codex-specific runtime assumptions
Instead of:
- Codex app-server as the only backend

Use:
- Cortex IDE control service
- runtime adapter layer underneath
- OpenClaw / ACP / Codex / Claude Code as pluggable backends

### Replace product framing
Instead of:
- “remote control for Codex on iPhone”

Use:
- “remote operator surface for agent organizations”

## Build strategy

### Step 1
Audit the public repo deeply:
- bridge
- relay
- iOS app surfaces
- session model
- security model

### Step 2
Decide adoption mode:
- reference only
- private fork
- vendor selective parts
- reimplement from scratch using the pattern

### Step 3
Implement Cortex IDE mobile bridge contract:
- pair
- subscribe
- notify
- approve
- steer
- inspect

### Step 4
Attach Cortex surfaces:
- recall search
- prior-fix summaries
- provenance-backed incident context

## Decision rule

If Remodex accelerates mobile by months, use it.
If it constrains architecture too much, borrow the pattern and rebuild cleanly.
