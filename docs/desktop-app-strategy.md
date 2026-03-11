# Desktop App Strategy

This doc captures the current **Option B + touch of A** path that Q approved.

## Decision

Keep the current **control-plane-first architecture**.
Do **not** pivot into a VS Code / Code-OSS fork yet.
Add a real **desktop app shell** early so the product stops feeling like "just a browser tab."

## Why

The current wedge is still the right one:
- command center
- fleet visibility
- approvals
- steering
- review
- memory / provenance
- phone remote control

That is more aligned with Karpathy's framing than starting with file tabs and extension plumbing.

## Current stance

### Keep
- Next.js / web UI for fast product iteration
- shared desktop + phone surface model
- runtime-agnostic control-plane architecture

### Add now
- native desktop shell wrapper
- app window, menu, multi-window navigation
- stronger local-product feel

### Defer
- Code-OSS / VS Code fork decision
- editor-native workbench investment
- extension-ecosystem complexity

## Why Electron now

Electron is not the end-state thesis.
It is the fastest way to give the product a real desktop-app shape **without discarding the current control-plane work**.

This keeps the real bet intact:
- agent-first
- org-control-first
- desktop + phone productivity loop

## Karpathy guardrail checklist

A change is aligned if it improves at least one of these:
- makes the **agent** more central than the file
- improves live visibility into idle / blocked / reviewing states
- improves inline tools and supervision
- improves usage / cost / context stats
- improves mobile remote operation
- improves reusable org-control patterns

A change is misaligned if it mainly adds:
- editor chrome without better operator leverage
- local gimmicks without better visibility or control
- fancy topology without faster real work

## Near-term implementation path

1. keep the Next.js control plane
2. wrap it in Electron for a real desktop shell
3. keep `/mobile` alive as the remote operator surface
4. wire real runtime truth into the shell
5. only then re-evaluate Code-OSS / Theia / other IDE bases
