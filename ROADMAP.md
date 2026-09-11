# o8 roadmap

o8 is the governance layer for autonomous engineering teams: approvals, audit, organizational memory, and operator control across AI providers. It sits above the coding agents, turns work into missions and packets, isolates execution in worktrees, keeps the operator in the approval path, and records enough evidence to explain what happened later. This page is the map of where that is going and what is open to work on. Taste is not a pillar on this map; it is a gate on all seven, because a change that does not read well, respond quickly, or behave predictably is not finished no matter which pillar it belongs to.

## How to read this

A checkbox is checked only when the child issue is closed and its fix is on `main` at or before tag `v0.1.749`, and a status percent is checked divided by total, rounded to the nearest 5. Each open arc has one tracking issue whose checklist is the real progress; the percent here only summarizes it. Frontier arcs carry a verdict and a date instead of a percent, because they are not committed work yet, and a Frontier arc graduates into a pillar when it ships its first child. Run `node scripts/roadmap-status.mjs` to recompute the numbers from the tracking issues; it prints a table and does not rewrite this file.

## 1. Governance is the product

Execution is separated from approval. Workers cannot merge their own packets, every decision is recorded, and every failure moves through a visible state.

| Arc | Done means | Status | Where |
| --- | --- | --- | --- |
| Merge-gate truth | A recorded verdict can never disagree with what actually lands on main. | 100% | shipped in 0.1.738 |
| Lane lifecycle and recovery honesty | No lane stalls silently, and every terminal state is reachable from the UI and the CLI. | 75% | [#2197](https://github.com/hurttlocker/o8/issues/2197) |
| Dispatch honesty | A confident mission plan in the thread implies a launched worker, or an error. | 100% | shipped in 0.1.749 |
| Signed receipts and truth queries | Someone who does not trust the operator can still verify a packet's claims. | 100% | shipped in 0.1.722 |
| Worker capability boundaries | A worker cannot read or reach anything its packet does not grant. | 75% | [#2198](https://github.com/hurttlocker/o8/issues/2198) |
| Broadcast: the audit trail as a live feed | The audit trail is something an operator watches, not only something they query. | 100% | shipped in 0.1.717 |
| Contributor-ready public repo | An outside pull request gets green checks and a human reply without maintainer plumbing. | 85% | [#2199](https://github.com/hurttlocker/o8/issues/2199) |

## 2. Organizational memory

Project rules and prior outcomes stay attached to the project rather than to one model vendor, so an orchestrator and its workers share the same operating context across runtimes.

| Arc | Done means | Status | Where |
| --- | --- | --- | --- |
| Engineering Brain question and answer | Any consumer, on any surface, gets a cited answer from the same retrieval path. | 100% | shipped, [#915](https://github.com/hurttlocker/o8/issues/915) |
| Workers write back to memory | A packet's lesson survives the packet. | 100% | shipped in 0.1.716 |
| Cost and capacity ledger | The ledger's number and the provider's invoice agree. | 75% | [#1791](https://github.com/hurttlocker/o8/issues/1791) |
| Spec review inversion | Project rules are operator-owned and agent-annotated, never agent-rewritten. | 100% | shipped |

## 3. Runs on your subscriptions

Local worker adapters launch the coding-agent CLIs you already pay for and reuse the authentication those tools already have. The runtime contract keeps callers independent of any one provider's protocol.

| Arc | Done means | Status | Where |
| --- | --- | --- | --- |
| Execution carriers | A model wrapper is a carrier choice, not a new entry in the runtime registry. | 100% | shipped in 0.1.748 |
| Declarative runtimes | A CLI-shaped runtime is a config row, not a six-file patch. | 100% | shipped in 0.1.725 |
| Carrier coverage and auth probes | A new carrier lands as a registry entry plus a readiness and auth probe, with no fork in the dispatch path. | 65% | [#2200](https://github.com/hurttlocker/o8/issues/2200) |
| OpenCode 2 and ACP | A non-subscription CLI is a first-class worker and a first-class orchestrator backend. | 80% | [#2201](https://github.com/hurttlocker/o8/issues/2201) |
| Local models first-class | Every surface names its local provider, and a test proves no egress for a full packet lifecycle. | parked, 3 of 3 carved children shipped | [#1451](https://github.com/hurttlocker/o8/issues/1451) |

## 4. One control plane, every surface

Desktop, mobile, CLI, MCP, headless, and voice all reach the same governed control plane, without giving every caller the same authority.

| Arc | Done means | Status | Where |
| --- | --- | --- | --- |
| Headless o8 | The control plane runs on a box with no screen. | 100% | shipped in 0.1.727 |
| Mobile as an operator surface | Approve, reject, steer, and read evidence from the phone. | 100% | shipped, [#1074](https://github.com/hurttlocker/o8/issues/1074) |
| Voice as an operator surface | The voice agent's brain seat is a registry choice, not a vendor branch. | 100% | shipped in 0.1.748 |
| Terminals as a workspace surface | A tmux or vim session survives a ship and a pane switch byte-faithfully, and terminal actions go through a governed adapter. | 90% | [#1723](https://github.com/hurttlocker/o8/issues/1723) |

## 5. Smooth for people and for agents

Two lanes, one pillar. The people lane is about the surfaces a human works in. The agents lane is about whether another program can drive o8 without pretending to be a mouse.

### People

| Arc | Done means | Status | Where |
| --- | --- | --- | --- |
| Canvas IDE parity | The canvas is a place you can actually work, not a demo surface. | 7 of 7 carved children shipped, epic open | [#1664](https://github.com/hurttlocker/o8/issues/1664) |
| Rich Markdown editor | Editing a document in o8 never corrupts it. | 100% | shipped in 0.1.722 |
| Design Mode loop | "Change this button" is one bounded loop with a proof card, not a packet. | 85% | [#1695](https://github.com/hurttlocker/o8/issues/1695) |
| Interaction budgets | Boot, typing, navigation, and scale each have a measured budget that a regression can fail. | 100% | shipped in 0.1.748 |

### Agents

| Arc | Done means | Status | Where |
| --- | --- | --- | --- |
| Control surfaces, not scraping | Every operator action is reachable from the CLI, MCP, and the socket, not only from a mouse. | 100% | shipped in 0.1.749 |
| CLI and MCP symmetry | The same control verb reaches the same governed route from an operator surface and from a worker context. | 100% | shipped in 0.1.738 |

## 6. Runs where you are

o8 should be light on the machine it runs on, and it should run on the machine you have.

| Arc | Done means | Status | Where |
| --- | --- | --- | --- |
| Mac hardening | A populated daily profile passes an unchanged native idle gate, with receipts. | 100% | shipped in 0.1.748 |
| Speed and idle-work pass | Interaction budgets hold under real load, not only at idle. | 85% | [#2202](https://github.com/hurttlocker/o8/issues/2202) |
| Storage admission and reclaim | o8 never blocks a dispatch it could have serviced, and never fills the disk. | 90% | [#2203](https://github.com/hurttlocker/o8/issues/2203) |
| Linux | A fresh Ubuntu box installs o8, launches it, dispatches a packet, and merges it through the governed path. | 90% | [#1672](https://github.com/hurttlocker/o8/issues/1672) |
| Windows | The same as Linux, on Windows. Help wanted: this needs a contributor with Windows hardware, because no maintainer has a Windows machine to verify on. The audit is already written, with file-and-line evidence, in `docs/internals/port-audit-windows.md`. | 50% | [#2204](https://github.com/hurttlocker/o8/issues/2204) |
| Release channels and build integrity | Preview and stable are separable, and a build is reproducible from a tag. | 90% | [#2205](https://github.com/hurttlocker/o8/issues/2205) |

## 7. Frontier

Directions we are looking at rather than committed to. These carry a verdict and a date instead of a percent. Exploring means the question is open and worth answering. Parked means we know what it would take and are not doing it now. An arc here graduates into a pillar when it ships its first child.

| Arc | Verdict | Since | Where |
| --- | --- | --- | --- |
| Connector layer for external tools | exploring | 2026-08-01 | [#1665](https://github.com/hurttlocker/o8/issues/1665) |
| Portable worker environments | exploring | 2026-08-03 | [#1690](https://github.com/hurttlocker/o8/issues/1690) |
| Cross-device execution continuity | exploring | 2026-08-04 | [#1727](https://github.com/hurttlocker/o8/issues/1727) |
| Worker OS sandbox as the default | parked | 2026-08-01 | [#1657](https://github.com/hurttlocker/o8/issues/1657) |
| Multiplayer workspace identity | parked | 2026-08-26 | [#1875](https://github.com/hurttlocker/o8/issues/1875) |
| Client-delegation transport for the voice brain seat | parked | 2026-09-11 | [#2166](https://github.com/hurttlocker/o8/issues/2166) |

## Claiming work

Start from a tracking issue above, open its checklist, and pick an unchecked child labeled `claimable`. Comment "claiming" on that child; a maintainer flips it to `claimed`, which expires after seven days with no linked pull request. The full protocol, including what a pull request needs before review, is in [CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work).

## Not on this map

Bug fixes, chores, security advisories, and dependency work are tracked as plain issues rather than roadmap arcs.
