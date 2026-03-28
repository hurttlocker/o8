# Conductor Changelog Synthesis — March 27, 2026

## Purpose

This document turns the Conductor changelog into a durable execution reference for Cortex IDE.

The goal is not feature mimicry. The goal is to identify which Conductor investments compound into operator-grade product quality, compare those release families against Cortex, and turn the gaps into a program.

Source reviewed: [Conductor changelog](https://www.conductor.build/changelog)

As of March 27, 2026, the visible live page runs from:
- `0.44.0` on March 24, 2026
- down to `0.0.16` on July 18, 2025

Visible release count on the page: `149`

## Method

This synthesis was done in seven passes over the same changelog:

1. Full chronological extraction of visible releases.
2. Net-new implementation vs extension vs hardening classification.
3. Terminal/runtime pass.
4. Workspace lifecycle/unread/status pass.
5. Review/GitHub/checks/comments pass.
6. Search/composer/manual operator workflow pass.
7. Model/provider/environment compatibility pass.

This is an analytical classification, not Conductor's own labeling.

## Executive Takeaways

- Conductor's moat is not one feature. It is repeated investment in a few control surfaces.
- The most important repeated themes are:
  - runtime truthfulness and terminal reliability
  - workspace lifecycle and unread/status control
  - review/comments/checks/GitHub operations
  - search/composer/navigation for operators
  - planning/approvals/checkpoint workflows
  - environment/model/provider compatibility
- The changelog is best understood as a sequence of implementation waves followed by repeated hardening, not as 149 unrelated releases.

## Release Waves

### Wave 1 — Foundation
Range: `0.0.16-0.3.2`

Net-new:
- terminal persistence and terminal bug cleanup
- GitHub integration
- attachments
- fine-grained GitHub permissions
- MCPs and message queues
- slash commands and custom providers
- local repositories and agents
- git diff
- early frontier model integration

Hardening:
- misc workflow cleanup
- early bugfix releases

### Wave 2 — Agent Shell + Review Baseline
Range: `0.5.0-0.11.6`

Net-new:
- GPT-5
- major product visual reset
- plan mode
- Linear integration
- scripts/hooks/custom fonts
- code review
- big terminal mode
- `conductor.json`

Hardening:
- terminal performance
- onboarding cleanup
- cancellation/review loop cleanup

### Wave 3 — Planning + Palette + Diff/Navigation
Range: `0.12.0-0.17.5`

Net-new:
- failing checks forwarded to Claude
- improved plan workflow
- wider provider compatibility
- command palette
- new diff system
- Linear workspaces / PR-start flow
- Claude thinking
- file explorer + diff viewer
- multiple chats
- sidebar Git status

### Wave 4 — Codex + Checkpoints + Review Maturity
Range: `0.18.0-0.23.3`

Net-new:
- Codex
- checkpoints
- file picker
- chat titles
- plan mode as a first-class workflow
- code review and historical diffs
- GPT-5.1 / Codex Max / custom review models
- terminal expansion, env vars, GitHub Enterprise
- repo details

### Wave 5 — Workspace Operating System
Range: `0.24.0-0.29.5`

Net-new or major expansion:
- improved Codex + quick start
- workspace storage overhaul
- response metadata
- pinned workspaces
- PR comment sync
- multiple repos
- forked workspaces
- unread handling
- workspace page
- Claude context
- interactive planning
- working directories
- todos
- search workspaces
- notes tab
- review comments on code
- deploy integration
- prompt customization
- PR checks

### Wave 6 — Workflow / Checks / Issues / Status
Range: `0.30.0-0.36.9`

Net-new or major expansion:
- Chrome tooling for Claude Code
- plan handoff
- search chats
- setup logs
- Checks tab
- GitHub issues
- Graphite stacks
- continue chats
- table of contents
- tasks
- GitHub Actions visibility
- PR editing
- chat summaries
- rerun actions
- workspace status
- group workspaces by repo
- next-workspace routing
- submit-a-prompt workflow

### Wave 7 — Manual Mode + Terminal Rewrite + Approvals
Range: `0.37.0-0.44.0`

Net-new or major expansion:
- built-in file editor / manual mode
- terminal rewrite
- multiline comments
- `direnv`
- extended-context models
- instant summarize
- operator-grade command palette
- fast mode
- tool approval
- Codex skills
- Codex plan mode
- rebuilt sidebar
- rebuilt composer
- Codex checkpoints
- `/add-dir`

## Change Buckets

Estimated bucket counts across the visible page:

- `58` net-new implementation releases
- `39` extension releases
- `52` hardening releases

Interpretation:
- Conductor shipped many new surfaces.
- But almost as many releases were spent making those surfaces trustworthy.
- The lesson for Cortex is to avoid shipping isolated features without the surrounding state model, lifecycle model, and recovery paths.

## Comparison Matrix

| Conductor release family | Representative releases | Cortex status | Recommended work |
| --- | --- | --- | --- |
| Terminal/runtime truthfulness | `0.0.16`, `0.10.2-0.10.5`, `0.11.4`, `0.22.4`, `0.29.5`, `0.30.0`, `0.38.1-0.38.4` | Partial | Unify terminal/session persistence, reconnect semantics, env resolution, live session truthfulness, and recovery UX across desktop/mobile. |
| Workspace lifecycle / unread / status | `0.17.0`, `0.20.0`, `0.25.3`, `0.25.6`, `0.28.0-0.28.1`, `0.33.5`, `0.35.0-0.36.5`, `0.39.0`, `0.44.0` | Behind | Build real archive/restore/history/unread/next-attention flows with one shared state model across board, dashboard, palette, and mobile. |
| Review / GitHub / checks / comments | `0.0.17`, `0.10.0`, `0.15.0-0.15.2`, `0.22.0`, `0.25.4`, `0.29.0-0.29.4`, `0.33.2`, `0.34.1`, `0.44.0` | Partial | Complete thread lifecycle: reply, resolve, viewed state, checks, PR metadata control, and durable GitHub sync. |
| Search / composer / operator navigation | `0.14.0`, `0.20.0`, `0.26.0`, `0.31.0`, `0.37.0`, `0.39.0`, `0.44.0` | Partial | Expand search to all transcripts and work objects; turn composer into a consistent control surface; add manual-edit escape hatches where appropriate. |
| Planning / approvals / checkpoints / Codex workflow | `0.7.3`, `0.19.0`, `0.21.0`, `0.25.5`, `0.28.0`, `0.30.0`, `0.34.2`, `0.41.0`, `0.43.0`, `0.44.0` | Behind | Ship persistent approvals, universal checkpoints, better plan handoff, and trustworthy paused/waiting/resumed states. |
| Models / providers / environment compatibility | `0.1.1`, `0.5.0`, `0.13.2`, `0.13.6`, `0.18.0`, `0.22.1`, `0.22.5`, `0.23.0`, `0.25.8`, `0.34.0`, `0.36.0`, `0.38.0`, `0.38.4` | Partial | Add explicit runtime environment compatibility for `direnv`, `mise`, `asdf`, `rbenv`; keep provider/model surfaces truthful and operational. |

## Strategic Standard For Cortex

Cortex should not cargo-cult Conductor's UI.

Cortex should absorb the structural lessons:

- one truthful runtime state model
- one truthful workspace lifecycle model
- one truthful approval model
- one searchable cross-runtime transcript universe
- one review/check/comment model
- one environment resolution model

The standard is:

- functionally complete
- operationally truthful
- visually restrained
- robust under restart, reconnect, and multi-surface use
- polished enough to feel like an executive product, not a lab tool

## Program Plan

### Phase A — Truthfulness First

Ship:
- persistent approval queue
- workspace lifecycle state
- runtime/env compatibility layer
- recovery-safe terminal/session persistence

Exit criteria:
- no fake approval states
- no placeholder archive/resume flows
- no stale "running" sessions after restart
- no session disappearance from reconnect churn

### Phase B — Operator Retrieval And Continuity

Ship:
- unified transcript/search index
- unread and next-attention flows
- universal checkpoints
- better chat/session summaries

Exit criteria:
- operator can find any active or historical session quickly
- operator can recover context without manual scrolling
- checkpointing works across major session types

### Phase C — Review And GitHub Completeness

Ship:
- reply/resolve/viewed review lifecycle
- checks surface maturity
- PR metadata editing
- issue/PR linkage consistency

Exit criteria:
- review loop is complete inside Cortex for common flows
- thread state survives refresh and sync changes

### Phase D — Finish The Professional Layer

Ship:
- consistent dialog/composer/search ergonomics
- manual fallback editing where appropriate
- mobile parity for approval and session continuity
- language and status copy cleanup

Exit criteria:
- product reads as one system
- desktop and mobile tell the same truth
- failure/recovery states are legible and calm

## Execution Issue Map

Primary tracker:

- GitHub epic `#290` — Conductor parity program from full changelog synthesis

Parallel implementation lanes:

- `#283` — persistent approvals across desktop and mobile
- `#284` — real workspace lifecycle management
- `#285` — universal search / operator console
- `#286` — checkpoints across all session types
- `#287` — PR review thread lifecycle
- `#288` — workspace environment compatibility layer
- `#289` — approval and chat recovery UX hardening
- `#291` — terminal/runtime truthfulness and reconnect recovery

Recommended parallelization:

- Track 1: `#283` + `#289`
  - shared approval state and approval UX
- Track 2: `#284` + `#291`
  - workspace lifecycle and runtime truthfulness
- Track 3: `#285` + `#286`
  - operator retrieval and continuity
- Track 4: `#287`
  - review lifecycle
- Track 5: `#288`
  - environment compatibility

Dependency notes:

- `#283` should land before approval UX polish is considered complete.
- `#284` and `#291` should define shared lifecycle truth before broad search ranking depends on unread/attention semantics.
- `#286` should align with the session identity rules from `#291`.
- `#287` can move in parallel with the rest because its write surface is relatively isolated.
- `#288` can move in parallel, but runtime launch changes should be reviewed alongside `#291`.

## Recommended Tracking Issue Shape

Suggested title:

`[Epic] Conductor changelog parity program: operator-grade lifecycle, approvals, search, review, and runtime truthfulness`

Suggested acceptance criteria:

- Reference synthesis exists in-repo and is kept current enough for planning.
- Each major Conductor family is mapped to a Cortex status and owner.
- P0/P1/P2 work is split into bounded implementation issues.
- Mobile and desktop parity is explicit where relevant.
- "Truthfulness first" is enforced over cosmetic feature parity.

## Reusable Prompt For Agents

Use this prompt when spawning or guiding implementation agents:

> You are working from `docs/research/conductor-changelog-synthesis-2026-03-27.md`.
> 
> Your task is not to copy Conductor literally. Your task is to close the structural gap between Cortex and the operator-grade capabilities Conductor repeatedly invested in.
> 
> Work at the highest level of abstraction first:
> 1. Identify the product family you are improving.
> 2. State the user-facing truth that must hold.
> 3. Define the shared state model and recovery model before touching UI.
> 4. Ensure desktop/mobile/runtime parity where applicable.
> 5. Remove placeholder behavior and fake states.
> 6. Ship verification for restart, reconnect, and multi-surface use.
> 
> For your output, always provide:
> - gap statement
> - current Cortex constraints
> - proposed state model
> - API/storage/runtime changes
> - desktop/mobile UX changes
> - failure/recovery cases
> - verification plan
> 
> The standard is executive-grade software: truthful, calm, durable, and operationally legible.
