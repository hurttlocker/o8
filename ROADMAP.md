# o8 roadmap

o8 is for one operator running several coding agents at once. It turns work into missions and packets, runs each packet in its own worktree, keeps the operator in the approval path, and records enough evidence to explain later what happened. All seven pillars serve one outcome: an operator delegates useful work, understands its state while away, steps in when needed, and approves the result without replaying the whole session. This page says where that is going and what is open to work on.

Taste is a gate on every row here, not a pillar of its own. A change that reads badly, responds slowly, or behaves unpredictably is not finished, whichever pillar it belongs to.

## At a glance

1. **Governance is the product.** Workers cannot merge their own work. The goal is to record every decision and make every failure visible and actionable.
2. **Organizational memory.** Rules and past outcomes stay with the project, not with one model vendor.
3. **Runs on your subscriptions.** The coding-agent CLIs you already pay for, behind one runtime contract.
4. **One control plane, every surface.** Desktop, phone, CLI, MCP, headless, voice. Same verbs, different authority.
5. **Smooth for people and for agents.** Fast and legible for a person; drivable through a real interface for a program.
6. **Runs where you are.** Light on the machine, on the machine you have. Mac today, Linux compiles but is unproven end to end, Windows help wanted.
7. **Ahead.** The bets for 2027 and 2028, with what we are already doing on each.

## Now

One arc first: **First ten minutes.** A new operator goes from download to a first merged packet, and the minutes and the stalls are measured. The first measurement exists: from source on a Mac, clone to merged packet took 6.8 minutes with nine stalls, one of them needing maintainer knowledge to pass. The eight product frictions behind those stalls are the arc's children, and the download path is still unmeasured. [#2211](https://github.com/hurttlocker/o8/issues/2211), [receipt](./docs/user/first-run-receipt-2026-09-12.md)

Linux is the next platform milestone. Nine of ten children are shipped; the last is the proof that a fresh mainstream distro installs o8, launches it, dispatches a packet, and merges it. [#2060](https://github.com/hurttlocker/o8/issues/2060)

Lane lifecycle and shared settings are gates on that path, not arcs that replace it. A refusal or a replaced mission must settle truthfully, and a changed setting must reach every surface on its next action. [#2197](https://github.com/hurttlocker/o8/issues/2197), [#2217](https://github.com/hurttlocker/o8/issues/2217)

## What we need to prove

Three outcomes decide whether the pillars add up. The first-diff comparisons below provide evidence on code quality; operator effort and the full loop's value still need measurement. A green checklist is progress on a row, not proof of the outcome.

- **A new operator finishes the loop.** Download to first merged packet, with the minutes and the stalls measured. Baseline from source: 6.8 minutes, nine stalls. The download path has no baseline. [#2211](https://github.com/hurttlocker/o8/issues/2211)
- **Interrupted work stays visible and recoverable.** A refusal surfaces, retries are bounded, and a replaced mission leaves no live packets behind. [#2197](https://github.com/hurttlocker/o8/issues/2197)
- **The governed loop earns its cost.** A first diff at least as good as the raw model on the same task remains the goal. Also compare final accepted quality, total attempts, reviews and rework, elapsed time, and the operator's time spent supervising, reviewing, and repairing the result, alongside attributable API cost or subscription capacity. An accurate ledger supports that comparison; it does not establish that delegation saves time or money, and subscription capacity is recorded as capacity, never converted into an invented per-token dollar saving. [#1684](https://github.com/hurttlocker/o8/issues/1684), [#1791](https://github.com/hurttlocker/o8/issues/1791)

## How to read this

Only open arcs appear in the pillar tables. Shipped arcs are listed once at the bottom with the release they landed in. Each open arc links to one tracking issue whose checklist is the real progress; a box is checked when the child issue is closed and its fix is in a shipped release, and GitHub shows the count on the issue itself.

State words mean: **open** has children in flight; **parked** means we know what it would take and are not doing it now; **not usable** means the platform does not run o8 today, whatever the checklist says. Read the Gap column first. It says what is missing in words.

`node scripts/roadmap-status.mjs` prints the checklist counts. `node scripts/roadmap-status.mjs --check` fails when a checked child is still open or when a Now link points at a closed issue. A closed child whose box is unchecked is reported as awaiting release, not as drift. CI runs the check on every push to main and weekly. The check reads issue state only: it does not read release tags and it cannot judge a Gap sentence, so the words on this page are the maintainers' to keep true.

## 1. Governance is the product

Execution is separated from approval. Workers cannot merge their own packets. This pillar requires decisions and failures to be recorded and visible, with a supported path to resolve them; the lifecycle row below tracks the remaining gaps.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Lane lifecycle and recovery honesty | No lane stalls silently. Every terminal state is reachable from the UI and the CLI. | open | A preflight-refused packet retries forever without surfacing. A superseded mission leaves its packets live. | [#2197](https://github.com/hurttlocker/o8/issues/2197) |
| Worker capability boundaries | A worker cannot read or reach anything its packet does not grant. | open | Native workers run under the operator's user account and can read the operator's environment. | [#2198](https://github.com/hurttlocker/o8/issues/2198) |
| Contributor-ready public repo | An outside pull request gets green checks and a human reply without maintainer plumbing. | open | This roadmap and the claiming protocol are new. No outside claim has gone through them yet. | [#2199](https://github.com/hurttlocker/o8/issues/2199) |
| First-diff quality | A governed packet's first diff scores at least as well as the raw model coding alone on the same issue. | open | Earlier headline comparisons reported 0/3 governed wins, but those scores were later withdrawn because judge bias could not be ruled out. Over-engineering and missed requirements remain the target failure modes. The later [paired contract trial](./docs/user/honest-benchmark-2026-08.md#track-1--coding-does-a-pre-edit-contract-improve-first-diff-quality) was mixed. The [September 12 fixed trial](https://github.com/hurttlocker/o8/issues/1684#issuecomment-5645498074) scored two complete tasks, with zero decisive contract wins in either runtime; one task was excluded for an invalid contract. The decision rule remains unmet. | [#1684](https://github.com/hurttlocker/o8/issues/1684) |

## 2. Organizational memory

Project rules and prior outcomes stay attached to the project, not to one model vendor. An orchestrator and its workers share the same operating context across runtimes.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Cost and capacity ledger | The ledger's number and the provider's invoice agree. | open | Nothing measures what role routing and context controls save. | [#1791](https://github.com/hurttlocker/o8/issues/1791) |
| Memory the operator shapes | What the operator rejects, steers, or edits becomes memory the Brain and the next worker retrieve, and any single retained item can be withdrawn from future retrieval without erasing the record that it was once applied. | open | Rejection and steer reasons are stored for audit and read by no retriever; the schema's rework flag is never written; the only way to forget one rule is to reset the whole database. | [#2221](https://github.com/hurttlocker/o8/issues/2221) |

## 3. Runs on your subscriptions

Local worker adapters launch the coding-agent CLIs you already pay for and reuse the authentication those tools already hold. The runtime contract keeps callers independent of any one provider's protocol.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Carrier coverage and auth probes | A new carrier lands as a registry entry plus a readiness and auth probe, with no fork in the dispatch path. | open | Readiness and auth checks are written per CLI, and the operator cannot see what evidence o8 used to call a runtime connected. The one adapter waiting is blocked on an upstream build for Intel Macs. | [#2200](https://github.com/hurttlocker/o8/issues/2200) |
| OpenCode 2 and ACP | A CLI that is not tied to a subscription works as a worker and as an orchestrator backend. | open | The empty-provider-list refusal is fixed on main and waits for the next release; after that the arc is shipped. | [#2201](https://github.com/hurttlocker/o8/issues/2201) |
| Local models first-class | Every surface names its local provider, and a test proves no egress for a full packet lifecycle. | parked | No surface-by-surface local path exists, and nothing proves that a packet leaves nothing behind on the network. The first narrow step is an egress baseline that names every contacted host and surface, even when it fails. | [#1451](https://github.com/hurttlocker/o8/issues/1451) |

## 4. One control plane, every surface

Desktop, mobile, CLI, MCP, headless, and voice reach the same governed control plane. Each caller gets its own authority; none of them gets the operator's by default.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Terminals as a workspace surface | A tmux or vim session survives an update and a pane switch byte for byte, and agent terminal actions go through a governed adapter. | open | Agent terminal actions are raw writes, and agent status inside a terminal is not inspectable. | [#1723](https://github.com/hurttlocker/o8/issues/1723) |
| Settings take effect everywhere | An operator changes a setting once and every surface uses the new value on its next action, with no reload and no second place to set it. | open | Operator defaults are snapshotted at page load and cached per terminal server; the same bug has recurred under four names. | [#2217](https://github.com/hurttlocker/o8/issues/2217) |

## 5. Smooth for people and for agents

Two lanes, one pillar. The people lane covers the surfaces a person works in. The agents lane covers whether another program can drive o8 through a real interface instead of imitating a mouse.

| Arc | Lane | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- | --- |
| First ten minutes | people | A stranger goes from download to a first merged packet, and the minutes and the stalls are measured. | open | Measured once, from source: 6.8 minutes and nine stalls. The web loop's folder picker hangs, browser state restores a repository the server never registered, and review approval hits an undocumented second gate. The download path is unmeasured. | [#2211](https://github.com/hurttlocker/o8/issues/2211) |
| Design Mode loop | people | "Change this button" is one bounded loop with a before-and-after proof card. | open | Screenshot crop timing is not measured through the supported capture path. | [#1695](https://github.com/hurttlocker/o8/issues/1695) |
| Agent-facing API manifest | agents | One manifest lists every operator verb and its surfaces, and CI fails when a verb exists on one surface and not another. | open | No manifest exists; parity between the CLI, MCP, and the webview socket is checked by hand. | [#2212](https://github.com/hurttlocker/o8/issues/2212) |

## 6. Runs where you are

o8 should be light on the machine it runs on, and it should run on the machine you have.

| Arc | Done means | State | Gap | Where |
| --- | --- | --- | --- | --- |
| Linux | A fresh Ubuntu machine installs o8, launches it, dispatches a packet, and merges it through the governed path. | not usable yet | Nobody has proven the install on a mainstream distro. | [#1672](https://github.com/hurttlocker/o8/issues/1672) |
| Windows | The same as Linux, on Windows. | not usable | Code signing is pending validation, and every child after the audit is unbuilt. | [#2204](https://github.com/hurttlocker/o8/issues/2204) |
| Speed and idle-work pass | Interaction budgets hold under real load, not only at idle. | open | Conversation switching and long histories slow down under streaming load. | [#2202](https://github.com/hurttlocker/o8/issues/2202) |
| Storage admission and reclaim | o8 never blocks a dispatch it could have serviced, and never fills the disk. | open | Admission uses one flat free-space reserve instead of the job's size. | [#2203](https://github.com/hurttlocker/o8/issues/2203) |
| Release channels and build integrity | Preview and stable are separable, and a build is reproducible from a tag. | open | Preview enrollment with an isolated app identity and data does not exist. | [#2205](https://github.com/hurttlocker/o8/issues/2205) |

Windows is help wanted. No maintainer has a Windows machine to verify on, so this arc needs a contributor who does. The port audit is written, with file-and-line evidence, in `docs/internals/port-audit-windows.md`.

## 7. Ahead

The bets for 2027 and 2028. Each row is an outcome we think operators will need, what already exists in o8 toward it, and the next child that would move it. A shipped child moves only the part it proves; a bet moves into a pillar when an operator can use the promised outcome. Rows are reviewed at the start of each month; a bet nobody has touched in a quarter gets cut, not carried.

| Bet | What already exists | Next child | Where |
| --- | --- | --- | --- |
| Agents that work while you are away, wherever they run. Hosted, remote, or local workers, days-long missions, the same packet and merge gate. | Headless o8, the mobile relay, crash survival, the durable execution spine. | A portable worker environment profile so a packet can be placed on a remote worker without changing its runtime contract. | [#1690](https://github.com/hurttlocker/o8/issues/1690), [#1727](https://github.com/hurttlocker/o8/issues/1727) |
| The right model for each packet, chosen and escalated by o8. A failed packet retries on a stronger tier without the operator choosing. | The carrier registry, per-packet model pins, the merge-failure escalation chain. | A worker escalation ladder that retries a failed packet on the next tier, with bounded attempts, the effective model visible, and a refusal instead of a silent fallback when the requested tier is unavailable. | [#2209](https://github.com/hurttlocker/o8/issues/2209) |
| Proof that travels. Receipts and control that systems outside o8 can verify and plug into, so o8 is the human gate inside other people's agent graphs. | Signed packet receipts and truth queries, the ACP orchestrator backend, MCP on both sides. | A receipt format another organization can verify without an o8 install, and a mission exported as an observed agent graph that an outside validator accepts. | [#1997](https://github.com/hurttlocker/o8/issues/1997), [#1998](https://github.com/hurttlocker/o8/issues/1998), [#2230](https://github.com/hurttlocker/o8/issues/2230) |
| Nothing leaves the machine unless you say so. Local and on-device models as a real mode with a test that proves it. | Local endpoint probes, the local chat tier for the Brain, an audit of surfaces without a local path. | A named egress baseline across a full packet lifecycle, listing every contacted host and surface, as the first narrow proof; remediation stays with the parked all-surfaces epic. | [#2228](https://github.com/hurttlocker/o8/issues/2228), [#1451](https://github.com/hurttlocker/o8/issues/1451) |
| Two operators, one approval path. Teams share a workspace without weakening who can approve what. | Principal-based authorization for operator, worker, and remote callers. | A workspace identity and role model. | [#1875](https://github.com/hurttlocker/o8/issues/1875) |
| Agents that use the screen, not only the repo. A packet can drive a browser or a GUI with the same isolation, review, and receipt. | The embedded browser agent and its governed verbs. | Computer-use as a worker capability behind the packet contract. | not yet filed |

## Shipped

Arcs whose every child is closed and released. They stay here so the pillars read as a whole, and they get no tracking issue.

- **Governance:** merge-gate truth (0.1.738); dispatch honesty (0.1.749); signed receipts and truth queries (0.1.722); Broadcast, the audit trail as a live feed (0.1.717).
- **Organizational memory:** Engineering Brain question and answer ([#915](https://github.com/hurttlocker/o8/issues/915)); workers write back to memory (0.1.716); spec review inversion, where the operator owns the rules and agents only annotate.
- **Runs on your subscriptions:** execution carriers (0.1.748); declarative runtimes (0.1.725).
- **One control plane, every surface:** headless o8 (0.1.727); mobile as an operator surface ([#1074](https://github.com/hurttlocker/o8/issues/1074)); voice as an operator surface, with the planning seat as a registry choice (0.1.748).
- **Smooth for people and for agents:** canvas IDE parity, carved scope ([#1664](https://github.com/hurttlocker/o8/issues/1664), 0.1.722); rich Markdown editor (0.1.722); interaction budgets (0.1.748); control surfaces instead of scraping (0.1.749); CLI and MCP symmetry (0.1.738).
- **Runs where you are:** Mac hardening, a populated daily profile through an unchanged native idle gate (0.1.748).

## Claiming work

Start from a tracking issue above, open its checklist, and pick an unchecked child labeled `claimable`. Comment "claiming" on that child. A maintainer flips it to `claimed`, which expires after seven days with no linked pull request. The full protocol, including what a pull request needs before review, is in [CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work).

## Not on this map

Bug fixes, chores, security advisories, and dependency work are tracked as plain issues, not as roadmap arcs.
