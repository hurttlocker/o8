# Performance Architecture Principles

This document captures the architecture rules behind the current speed,
realtime, and local-first work on Cortex IDE. It is intended to keep future
changes aligned with the same performance model instead of reintroducing slow
request paths, duplicate truth, or broad rerender churn.

## Core Principle

The app should feel fast because the architecture is fast, not because the UI
lies.

That means:

- initial HTML must return quickly
- shell render must not block on heavy discovery
- live truth must reconcile after shell render through shared state
- freshness must be explicit: `live`, `warming`, `stale`, `degraded`
- optimistic UI must reconcile deterministically with server truth

## Route Render Rules

- Initial route render should read only hot, already-assembled truth.
- `/` and `/mobile` should stream usable shell HTML before full live discovery settles.
- If live truth cannot be assembled inside budget, the route must degrade
  explicitly to `warming`, `stale`, or `degraded`.
- Heavy work must move off the initial HTML request path.

### Request-Path Denylist

The following work classes should not sit under first HTML:

- CLI fallback
- runtime discovery rebuilds
- repo/worktree snapshot rebuilds
- browser discovery
- expensive mobile inbox derivation
- any synchronous cross-process truth assembly when a hot broker snapshot exists

## Shared Truth Rules

- Each operator entity should have one canonical source of truth.
- SSR bootstrap, realtime updates, and client consumers should use the same
  entity model where practical.
- Client and server equality checks must use shared functions, not duplicated
  logic.
- Attached browser state, review state, fleet state, and inbox state should not
  have command-center-local-only truth paths.

## Realtime Replication Rules

Treat realtime as state replication, not ad hoc notifications.

Every envelope should carry:

- `stream`
- `entityId`
- `seq`
- optional `capturedSeq`
- `delivery`
- `health`

### Ordering

- Updates must be gated at the entity level, not just the stream level.
- Bootstrap and resync snapshots must be fenced so they cannot overwrite newer
  live entity state.
- Replay gaps must be detected explicitly.
- If replay cannot satisfy `since`, the client should receive an authoritative
  degraded resync instead of a silent partial replay.

### Freshness

- `live` means current enough for operator decisions.
- `warming` means the app is still assembling truth.
- `stale` means known truth exists but is past acceptable freshness.
- `degraded` means the system is serving reduced or fallback truth.

Health should aggregate by channel or entity class, not by whichever event
arrived last.

## Cache and Invalidation Rules

- Cache invalidation should use generations where stale inflight work is
  possible.
- Clearing a cache without guarding inflight completion is not enough.
- Higher layers must not recache lower-layer stale state as fresh.
- Fresh reads must actually be fresh; they should not silently reuse stale
  observable/browser/activity state.

## Mutation Reconciliation Rules

- Every optimistic action should have a `clientMutationId`.
- Mutation records should be shared between server and client.
- Reconciliation should be session-scoped so an older settled mutation cannot
  clear or overwrite a newer pending action on the same session.
- Authoritative server truth should replace optimistic state once it arrives.
- Force/resync history paths should preserve only still-pending optimistic
  entries.

## UI and Hydration Rules

- Keep local interaction state local.
- Typing, draft state, open panels, selected tabs, scroll position, and local
  optimistic UI should not depend on broad snapshot rebuilds.
- Use one WS connection per surface tree and fan out locally.
- Lazy-hydrate noncritical panels.
- Virtualize long transcripts, event rails, file lists, and timelines where
  DOM size can grow materially.
- Narrow interactions should not rerender broad parent screens unnecessarily.

## Broker Rules

If route bootstrap uses a hot in-memory broker:

- define which long-lived process owns it
- define how routes read it
- define what happens when it is unavailable or restarting
- preserve coherent freshness metadata on brokered snapshots
- bound its memory and lifecycle explicitly

The broker should replace rebuild-on-request, not just wrap it.

## Measurement and Proof

Performance claims should be auditable.

Use:

- `Server-Timing` or equivalent route timing surfaces
- explicit logs for shell render, broker read, degraded timeout, and background refresh kickoff
- reproducible cold and warm measurement scripts for `/` and `/mobile`

The code should make it possible to answer:

- Did this request serve shell-only, broker-hot truth, or degraded fallback?
- Did any heavy discovery work run under initial HTML?
- Did the route meet budget or fail fast truthfully?

## Checklist For New Work

Before landing a change, ask:

1. Does this add heavy work to the initial HTML request path?
2. Does this create a second source of truth for an existing entity?
3. Can a stale inflight request overwrite newer entity state?
4. Does optimistic UI have deterministic reconciliation?
5. Does the equality or ETag logic use a shared canonical signature?
6. Does this broaden rerender or hydration scope unnecessarily?
7. Can the result be measured and audited later?

If any answer is "yes", the design likely needs another pass before merge.
