# o8 roadmap

o8 is for one operator running several coding agents at once. It turns work into missions and packets, runs each packet in its own worktree, keeps the operator in the approval path, and records enough evidence to explain later what happened. This page says where that is going and what is open to work on.

Taste is a gate on every row here, not a pillar of its own. A change that reads badly, responds slowly, or behaves unpredictably is not finished, whichever pillar it belongs to.

## At a glance

Seven pillars. One line each.

1. **Governance is the product.** Workers cannot merge their own work; every decision and failure is recorded and visible.
2. **Organizational memory.** Rules and past outcomes stay with the project, not with one model vendor.
3. **Runs on your subscriptions.** The coding-agent CLIs you already pay for, behind one runtime contract.
4. **One control plane, every surface.** Desktop, phone, CLI, MCP, headless, voice. Same verbs, different authority.
5. **Smooth for people and for agents.** Fast and legible for a person; drivable through a real interface for a program.
6. **Runs where you are.** Light on the machine, on the machine you have. Mac today, Linux one proof away, Windows help wanted.
7. **Ahead.** The bets for 2027 and 2028, with what we are already doing on each.

## Now

The maintainer's focus for September 2026. Three arcs, each one gap from its next milestone.

| Arc | The gap | Where |
| --- | --- | --- |
| Linux | Prove that a fresh mainstream distro installs o8, launches it, dispatches a packet, and merges it. Nine of ten children are shipped; this is the one that makes Linux usable. | [#2060](https://github.com/hurttlocker/o8/issues/2060) |
| Lane lifecycle and recovery honesty | Two failure modes still hide: a packet refused at dispatch preflight retries forever without surfacing, and superseding a mission leaves its packets live. | [#2195](https://github.com/hurttlocker/o8/issues/2195), [#2196](https://github.com/hurttlocker/o8/issues/2196) |
| Runtime readiness | An authenticated OpenCode 2 install can still be refused dispatch because the CLI reports an empty provider list. Readiness checks are written per CLI; a shared conformance check would have caught this before a user did. | [#2194](https://github.com/hurttlocker/o8/issues/2194), [#2200](https://github.com/hurttlocker/o8/issues/2200) |
| First ten minutes | Nobody has measured how long a stranger takes from download to a first merged packet, or where they stall. The number goes here once it exists. | [#2211](https://github.com/hurttlocker/o8/issues/2211) |

## How to read this

Each open arc has one tracking issue. Its checklist is the real progress; the percent here only summarizes that checklist. A box is checked when the child issue is closed and its fix is in a shipped release.

Read the Gap column before the percent. Most open arcs are one child from done. That says the maintainer files small issues; it does not say the work is nearly finished.

Ahead rows are bets, not committed arcs. Each names the outcome we are betting on, what already exists toward it, and the next child. A bet moves into a pillar when that child ships.

`node scripts/roadmap-status.mjs` recomputes the percents from the tracking issues. It prints a table and does not rewrite this file.

## 1. Governance is the product

Execution is separated from approval. Workers cannot merge their own packets, every decision is recorded, and every failure moves through a visible state.

| Arc | Done means | Status | Gap | Where |
| --- | --- | --- | --- | --- |
| Merge-gate truth | A recorded verdict never disagrees with what lands on main. | 100% | none | shipped in 0.1.738 |
| Lane lifecycle and recovery honesty | No lane stalls silently. Every terminal state is reachable from the UI and the CLI. | 75% | A preflight-refused packet retries forever without surfacing. A superseded mission leaves its packets live. | [#2197](https://github.com/hurttlocker/o8/issues/2197) |
| Dispatch honesty | A mission plan in the thread implies a launched worker, or an error. | 100% | none | shipped in 0.1.749 |
| Signed receipts and truth queries | Someone who does not trust the operator can still verify a packet's claims. | 100% | none | shipped in 0.1.722 |
| Worker capability boundaries | A worker cannot read or reach anything its packet does not grant. | 75% | Native workers run under the operator's user account and can read the operator's environment. | [#2198](https://github.com/hurttlocker/o8/issues/2198) |
| Broadcast: the audit trail as a live feed | The operator watches the audit trail instead of only querying it. | 100% | none | shipped in 0.1.717 |
| Contributor-ready public repo | An outside pull request gets green checks and a human reply without maintainer plumbing. | 85% | This roadmap and the claiming protocol are new. No outside claim has gone through them yet. | [#2199](https://github.com/hurttlocker/o8/issues/2199) |
| First-diff quality | A governed packet's first diff scores at least as well as the raw model coding alone on the same issue. | 0% | Two blind benchmarks, two months and two model generations apart, both lost three of three to the raw model, and both lost the same two ways: over-engineering and missed sub-requirements. Nobody owns this yet. | [#1684](https://github.com/hurttlocker/o8/issues/1684) |

## 2. Organizational memory

Project rules and prior outcomes stay attached to the project, not to one model vendor. An orchestrator and its workers share the same operating context across runtimes.

| Arc | Done means | Status | Gap | Where |
| --- | --- | --- | --- | --- |
| Engineering Brain question and answer | Any consumer, on any surface, gets a cited answer from the same retrieval path. | 100% | none | shipped, [#915](https://github.com/hurttlocker/o8/issues/915) |
| Workers write back to memory | A packet's lesson survives the packet. | 100% | none | shipped in 0.1.716 |
| Cost and capacity ledger | The ledger's number and the provider's invoice agree. | 75% | Nothing measures what role routing and context controls save. | [#1791](https://github.com/hurttlocker/o8/issues/1791) |
| Spec review inversion | The operator owns the project rules. Agents annotate them and never rewrite them. | 100% | none | shipped |

## 3. Runs on your subscriptions

Local worker adapters launch the coding-agent CLIs you already pay for and reuse the authentication those tools already hold. The runtime contract keeps callers independent of any one provider's protocol.

| Arc | Done means | Status | Gap | Where |
| --- | --- | --- | --- | --- |
| Execution carriers | A model wrapper is a carrier choice, not a new entry in the runtime registry. | 100% | none | shipped in 0.1.748 |
| Declarative runtimes | A CLI-shaped runtime is a config row, not a six-file patch. | 100% | none | shipped in 0.1.725 |
| Carrier coverage and auth probes | A new carrier lands as a registry entry plus a readiness and auth probe, with no fork in the dispatch path. | 65% | Readiness and auth checks are written per CLI. The one adapter waiting is blocked on an upstream build for Intel Macs. | [#2200](https://github.com/hurttlocker/o8/issues/2200) |
| OpenCode 2 and ACP | A CLI that is not tied to a subscription works as a worker and as an orchestrator backend. | 80% | An authenticated install can be refused dispatch when the CLI reports an empty provider list. | [#2201](https://github.com/hurttlocker/o8/issues/2201) |
| Local models first-class | Every surface names its local provider, and a test proves no egress for a full packet lifecycle. | parked | No surface-by-surface local path exists, and nothing proves that a packet leaves nothing behind on the network. | [#1451](https://github.com/hurttlocker/o8/issues/1451) |

## 4. One control plane, every surface

Desktop, mobile, CLI, MCP, headless, and voice reach the same governed control plane. Each caller gets its own authority; none of them gets the operator's by default.

| Arc | Done means | Status | Gap | Where |
| --- | --- | --- | --- | --- |
| Headless o8 | The control plane runs on a machine with no screen. | 100% | none | shipped in 0.1.727 |
| Mobile as an operator surface | Approve, reject, steer, and read evidence from the phone. | 100% | none | shipped, [#1074](https://github.com/hurttlocker/o8/issues/1074) |
| Voice as an operator surface | The voice agent's planning seat is a registry choice, not a vendor branch. | 100% | none | shipped in 0.1.748 |
| Terminals as a workspace surface | A tmux or vim session survives an update and a pane switch byte for byte, and agent terminal actions go through a governed adapter. | 90% | Agent terminal actions are raw writes, and agent status inside a terminal is not inspectable. | [#1723](https://github.com/hurttlocker/o8/issues/1723) |

## 5. Smooth for people and for agents

Two lanes, one pillar. The people lane covers the surfaces a person works in. The agents lane covers whether another program can drive o8 through a real interface instead of imitating a mouse.

### People

| Arc | Done means | Status | Gap | Where |
| --- | --- | --- | --- | --- |
| Canvas IDE parity | A full editing session happens on the canvas: open a file by name, search the repo, edit, diff, commit. | 100% of carved scope | The seven carved children are shipped and the epic is closed. Further canvas work will be filed as new children here. | shipped in 0.1.722, [#1664](https://github.com/hurttlocker/o8/issues/1664) |
| Rich Markdown editor | Editing a document in o8 never corrupts it. | 100% | none | shipped in 0.1.722 |
| Design Mode loop | "Change this button" is one bounded loop with a before-and-after proof card. | 85% | Screenshot crop timing is not measured through the supported capture path. | [#1695](https://github.com/hurttlocker/o8/issues/1695) |
| Interaction budgets | Boot, typing, navigation, and scale each have a measured budget that a regression can fail. | 100% | none | shipped in 0.1.748 |

### Agents

| Arc | Done means | Status | Gap | Where |
| --- | --- | --- | --- | --- |
| Control surfaces, not scraping | Every operator action is reachable from the CLI, MCP, and the webview socket. | 100% | none | shipped in 0.1.749 |
| CLI and MCP symmetry | The same control verb reaches the same governed route from an operator surface and from a worker context. | 100% | none | shipped in 0.1.738 |
| Agent-facing API manifest | One manifest lists every operator verb and its surfaces, and CI fails when a verb exists on one surface and not another. | 0% | No manifest exists; parity between the CLI, MCP, and the webview socket is checked by hand. | [#2212](https://github.com/hurttlocker/o8/issues/2212) |

## 6. Runs where you are

o8 should be light on the machine it runs on, and it should run on the machine you have.

| Arc | Done means | Status | Gap | Where |
| --- | --- | --- | --- | --- |
| Mac hardening | A populated daily profile passes an unchanged native idle gate, with receipts. | 100% | none | shipped in 0.1.748 |
| Speed and idle-work pass | Interaction budgets hold under real load, not only at idle. | 85% | Conversation switching and long histories slow down under streaming load. | [#2202](https://github.com/hurttlocker/o8/issues/2202) |
| Storage admission and reclaim | o8 never blocks a dispatch it could have serviced, and never fills the disk. | 90% | Admission uses one flat free-space reserve instead of the job's size. | [#2203](https://github.com/hurttlocker/o8/issues/2203) |
| Linux | A fresh Ubuntu machine installs o8, launches it, dispatches a packet, and merges it through the governed path. | 90%, not usable yet | Nobody has proven the install on a mainstream distro. | [#1672](https://github.com/hurttlocker/o8/issues/1672) |
| Windows | The same as Linux, on Windows. | 50%, not usable | Code signing is pending validation, and every child after the audit is unbuilt. | [#2204](https://github.com/hurttlocker/o8/issues/2204) |
| Release channels and build integrity | Preview and stable are separable, and a build is reproducible from a tag. | 90% | Preview enrollment with an isolated app identity and data does not exist. | [#2205](https://github.com/hurttlocker/o8/issues/2205) |

Windows is help wanted. No maintainer has a Windows machine to verify on, so this arc needs a contributor who does. The port audit is written, with file-and-line evidence, in `docs/internals/port-audit-windows.md`.

## 7. Ahead

The bets for 2027 and 2028. Each row is an outcome we think operators will need, what already exists in o8 toward it, and the next child that would move it. A bet moves into a pillar when that child ships. Rows are reviewed at the start of each month; a bet nobody has touched in a quarter gets cut, not carried.

| Bet | What already exists | Next child | Where |
| --- | --- | --- | --- |
| Agents that work while you are away, wherever they run. Hosted, remote, or local workers, days-long missions, the same packet and merge gate. | Headless o8, the mobile relay, crash survival, the durable execution spine. | A portable worker environment profile so a packet can be placed on a remote worker without changing its runtime contract. | [#1690](https://github.com/hurttlocker/o8/issues/1690), [#1727](https://github.com/hurttlocker/o8/issues/1727) |
| The right model for each packet, chosen and escalated by o8. A failed packet retries on a stronger tier without the operator choosing. | The carrier registry, per-packet model pins, the merge-failure escalation chain. | A worker escalation ladder that retries a failed packet on the next tier. | [#2209](https://github.com/hurttlocker/o8/issues/2209) |
| Proof that travels. Receipts and control that systems outside o8 can verify and plug into, so o8 is the human gate inside other people's agent graphs. | Signed packet receipts and truth queries, the ACP orchestrator backend, MCP on both sides. | A receipt format another organization can verify without an o8 install. | [#1997](https://github.com/hurttlocker/o8/issues/1997), [#1998](https://github.com/hurttlocker/o8/issues/1998) |
| Nothing leaves the machine unless you say so. Local and on-device models as a real mode with a test that proves it. | Local endpoint probes, the local chat tier for the Brain, an audit of surfaces without a local path. | An egress assertion test across a full packet lifecycle. | [#1451](https://github.com/hurttlocker/o8/issues/1451) |
| Two operators, one approval path. Teams share a workspace without weakening who can approve what. | Principal-based authorization for operator, worker, and remote callers. | A workspace identity and role model. | [#1875](https://github.com/hurttlocker/o8/issues/1875) |
| Agents that use the screen, not only the repo. A packet can drive a browser or a GUI with the same isolation, review, and receipt. | The embedded browser agent and its governed verbs. | Computer-use as a worker capability behind the packet contract. | not yet filed |

## Claiming work

Start from a tracking issue above, open its checklist, and pick an unchecked child labeled `claimable`. Comment "claiming" on that child. A maintainer flips it to `claimed`, which expires after seven days with no linked pull request. The full protocol, including what a pull request needs before review, is in [CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work).

## Not on this map

Bug fixes, chores, security advisories, and dependency work are tracked as plain issues, not as roadmap arcs.
