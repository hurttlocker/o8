# Mobile Strategy — Cortex IDE

## Conclusion first

**Yes: mobile support should exist from day one.**

But not as “full IDE on a phone.”
The better architecture is:

- heavy work runs on desktop / server
- mobile is the remote operator surface

This is the key lesson from the Remodex thread and repo architecture.

## Why mobile matters early

Multi-agent operation naturally creates moments where the operator is away from the desk but still needs to:

- approve a risky action
- unblock an agent
- inspect a failure
- steer a run
- review a PR summary
- see whether a job actually finished

If Cortex IDE is about controlling an agent organization, mobile is not optional for long.
It is part of the thesis.

## What the Remodex thread proves

The Remodex idea shows that:

1. a phone can be a highly useful controller for desktop agent runtimes
2. a local-first bridge plus paired mobile app is feasible
3. QR-based pairing is a strong onboarding flow
4. mobile can meaningfully support git status, diffs, notifications, and task watching
5. an open-source bridge can coexist with a managed relay / app distribution model

That is important because it means Cortex IDE does not need to invent a fantasy mobile story.
There is already a viable architecture pattern.

## Day-one mobile jobs

### Must-have jobs
- push notification when run completes / fails / blocks
- approve / deny requests
- pause / resume / kill agent
- send steer message
- inspect concise run summary
- inspect alerts and budgets
- search Cortex for related memory and prior fixes

### Strong early jobs
- view diff summary
- view PR queue
- read terminal tail / last logs
- switch between squads / agents
- jump to desktop deep link when needed

### Not day-one jobs
- full repo editing
- giant file navigation
- full IDE parity
- complex worktree manipulation from touch UI

## Recommended architecture

```text
[iOS App]
    <-> paired encrypted session / notification channel <->
[Cortex IDE control service]
    <-> runtime adapters / Cortex / GitHub / artifacts
```

### Pairing flow
1. Desktop creates device session
2. User scans QR with mobile app
3. Mobile and control plane establish trust
4. App subscribes to operator-safe event stream
5. Quick actions become available immediately

### Transport model
Use a secure relay-capable architecture:
- local-first where possible
- relay only when needed
- end-to-end encrypted payloads for operator actions and sensitive state

## Cortex-specific mobile advantage

Cortex makes mobile dramatically more useful than a dumb remote-control app.

Instead of just seeing “Agent failed,” the phone can show:

- last task summary
- relevant prior incidents
- learned fix patterns
- repo / branch / PR context
- memory-backed suggested next actions

That turns mobile from a pager into a real operating console.

## Mobile information hierarchy

### Tier 1 — immediate action
- run failed
- approval requested
- budget exceeded
- high-severity alert

### Tier 2 — important state
- run complete
- review ready
- blocker cleared
- PR opened

### Tier 3 — passive awareness
- squad throughput
- daily summaries
- memory health trends

## UI recommendation

Mobile UI should optimize for:

- fast glanceability
- one-handed actions
- obvious severity
- minimal typing when possible
- deep linking to desktop when the task is too complex

Suggested tabs:
- **Inbox** — approvals, alerts, reviews
- **Fleet** — agents and squads
- **Runs** — active and recent work
- **Memory** — Cortex search and incident recall
- **Account** — device pairing, permissions, settings

## Product recommendation

### For v0
Ship mobile as a thin but real operator companion.

### For later
Expand into:
- voice steering
- richer diff review
- mobile-first incident response
- background watch modes
- wearable / notification-only quick actions

## Strategic payoff

If Cortex IDE supports desktop + mobile from the start, it becomes more than an editor idea.
It becomes a genuine **operating system for agent work**.
