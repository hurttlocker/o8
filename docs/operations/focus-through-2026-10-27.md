# Focus through October 27, 2026

This is the execution plan for the September 27 to October 27 window. Updated October 2. The [roadmap](../../ROADMAP.md) keeps the longer-term arcs; this page identifies what should get attention now. A maintainer confirms ownership on the issue before work starts. This page does not assign a contributor or authorize a release.

The month serves successful first runs, retained users, outside contributions, and paid-tier behavior that works as described. Symon reliability remains a standing priority. Complete the current acceptance step or record its exact blocker before advancing the engineering queue.

## Engineering order

| Order | Outcome | Work | Acceptance |
| --- | --- | --- | --- |
| 1 | A new operator reaches a first reviewed merge | [#2873](https://github.com/hurttlocker/o8/issues/2873), [#2211](https://github.com/hurttlocker/o8/issues/2211), including comparison stop/requeue [#2862](https://github.com/hurttlocker/o8/issues/2862) | A signed universal candidate passes installed first-run checks and a second fresh run without stalls. Preserve Solo tools and sent-image checks. Physical Apple Silicon execution and the published download path are separate evidence. |
| 2 | The funnel can be measured without changing existing privacy choices | [#2882](https://github.com/hurttlocker/o8/issues/2882), update-service delivery and the corresponding privacy documentation | Verify the deployed endpoint, installed client, opt-out persistence and resulting counts. A closed source issue is insufficient. Do not delay a first-run repair for unrelated analytics expansion. |
| 3 | Paid-tier benefits match the account | Verify entitlement, feature access and managed-use limits through the installed app | Record the effective account plan and actual allowed/refused behavior. Source closure does not prove a checkout launch or service deployment. Keep commercial changes and publication under their existing approval gates. |
| 4 | Existing Symon behavior is dependable | [#2534](https://github.com/hurttlocker/o8/issues/2534), then [#2636](https://github.com/hurttlocker/o8/issues/2636) and [#2639](https://github.com/hurttlocker/o8/issues/2639) | Verify session, model, tool-result, interruption, reconnect and approval behavior. Model availability needs actual account-specific dispatch evidence under [#2634](https://github.com/hurttlocker/o8/issues/2634). |

As of October 2, published stable is 0.1.778. A signed 0.1.779 candidate has reached an installed reviewed merge, but that observation is not the required clean repeat or a public download benchmark. First-run acceptance remains open. Keep candidate acceptance, merged source, and public release recorded separately.

The already-scoped connected-plugin and sign-in work is a post-release follow-up. It does not bypass the first-run queue or establish that hosted access is ready. [#2951](https://github.com/hurttlocker/o8/issues/2951), [#2952](https://github.com/hurttlocker/o8/issues/2952), [#2955](https://github.com/hurttlocker/o8/issues/2955)

## Two contributor queues

These are starting options, not reservations. Recheck the issue state, linked PR and current claim before choosing one. Pick one issue at a time; finish review before claiming another. Each linked brief contains its file scope and verification command. Follow [Claiming work](../../CONTRIBUTING.md#claiming-work).

| Queue | First choices, open and claimable on October 2 | Done means |
| --- | --- | --- |
| A: Clear actions and accessible disclosure | [#3038](https://github.com/hurttlocker/o8/issues/3038) urgent-toast action names; then [#3022](https://github.com/hurttlocker/o8/issues/3022) command-strip disclosure or [#3021](https://github.com/hurttlocker/o8/issues/3021) compaction disclosure | An operator can identify and use the control with keyboard and assistive technology; the focused behavior check and normal completion checks pass. |
| B: Honest feedback and contributor setup | [#3018](https://github.com/hurttlocker/o8/issues/3018) diff-path copy; then [#3019](https://github.com/hurttlocker/o8/issues/3019) dictation-history copy, or the documentation task [#2855](https://github.com/hurttlocker/o8/issues/2855) | Success feedback follows actual clipboard success, failure remains recoverable, or documented test commands match the repository's configured lanes. |

Already claimed: [#3020](https://github.com/hurttlocker/o8/issues/3020), [#3023](https://github.com/hurttlocker/o8/issues/3023), and the governed-terminal work [#2229](https://github.com/hurttlocker/o8/issues/2229). Preserve those owners. Review existing contributor PRs before creating competing implementations. Authentication, payments, dispatch internals and release machinery are not starter tasks.

## Checkpoints for the remaining window

Dates are review checkpoints, not permission to skip acceptance gates.

| Date | Engineering checkpoint | Maintainer and contributor checkpoint |
| --- | --- | --- |
| October 2–3 | Identify the exact first-run blocker and the next installed acceptance action. Keep the candidate fixed during measurement. | Reconcile open contributor work and publish the bounded queue. Record a current scoreboard or mark unavailable measures unknown. |
| October 4–10 | Finish the clean first-run repeat, or keep its blocker and owner explicit. Advance to entitlement only after the first-run work is complete or explicitly held. | Help each contributor land one focused change. Reply to outside issues and PRs within 24 hours. |
| October 11–17 | Prove paid-tier behavior, then conduct the Symon reliability review. | Produce a demo from verified behavior. Help new contributors through claiming, checks and review. |
| October 18–27 | Complete bounded Symon follow-ups and reconcile acceptance and release evidence. | Compare the month's install, retention and contribution evidence; decide the next window and which parked work earns a restart. |

Record weekly new installs, seven-day active installs, new paying users, and unique outside contributors with a merged PR or accepted useful issue. Exclude test identities and bots. Record unavailable data as unknown; downloads, accounts and app launches are different measurements. Retain dated baselines rather than silently treating them as current counts. Public posts and outreach follow the existing approval process.

## Work held outside this queue

Revisit these programs on October 27: broad remote operation [#2282](https://github.com/hurttlocker/o8/issues/2282), cross-device continuity [#1727](https://github.com/hurttlocker/o8/issues/1727), workspace services [#1725](https://github.com/hurttlocker/o8/issues/1725), Design Mode [#1695](https://github.com/hurttlocker/o8/issues/1695), stacked-PR expansion, new carrier/profile programs, and Linux product validation [#1672](https://github.com/hurttlocker/o8/issues/1672). Linux execution of existing test suites is separate from Linux product acceptance.

Preserve already-scoped work and its evidence. A separately authorized remote or plugin task can finish its bounded scope, but its existence does not expand the first-run release candidate or restart the broader program. Do not launch new terminal/CLI expansion after the current contributor PR cluster.

Before adding work, state which current outcome it advances, why this is the smallest useful change, who owns it, and what observation will prove completion. If those answers are absent, put it in the next-window review.
