# ChatGPT plugin usage routes and measurement

The connected plugin provides an entry into existing o8 work. Reading its state
does not start an o8 model turn. Asking a worker to continue does start work on
that worker's configured account and route. These are separate operations.

This document records the research and measurement contract for
[#3247](https://github.com/hurttlocker/o8/issues/3247) and the comparison in
[#3251](https://github.com/hurttlocker/o8/issues/3251). Official guidance was
checked October 5, 2026. No o8-specific subscription savings have been measured.

## Documented accounting boundaries

[OpenAI's pricing guidance](https://learn.chatgpt.com/docs/pricing) says Codex
and ChatGPT Work share usage. Model choice, context, reasoning, tools and caching
affect consumption. Credit prices and token totals do not measure included
subscription allowance.

[Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)
separates identity permission from plan-use permission. Eligible app inference
uses the existing Codex/Work allowance. Connecting an app adds no allowance;
an app cap limits consumption rather than reserving extra capacity. Permission
to use a plan does not expose ChatGPT conversations or memories.

Those rules do not establish how much an ordinary Chat conversation using o8
tools consumes, or whether moving planning there saves Codex capacity. Treat
that comparison as unknown until an attributable measurement or product-specific
clarification resolves it.

## Route matrix

| Route | Identity and permission | Executor and model settings | Allowance or payer | Evidence and visibility |
| --- | --- | --- | --- | --- |
| Ordinary Chat without tools | Host ChatGPT account | Chat model; record displayed model and reasoning/speed settings | Applicable Chat limits | Baseline condition; exact per-turn attribution may be unavailable |
| Ordinary Chat with o8 discovery/status/result | Host account plus limited o8 OAuth grant | Chat model plus deterministic relay/desktop reads | Host limits; the read starts no o8 inference | Installed reads passed; tool/context overhead and host quota attribution are unmeasured |
| Ordinary Chat with an explicitly requested existing-task follow-up | Host account, o8 follow-up scope and bound task | Chat model, deterministic admission, configured worker and any review/retry work | Host limits plus every executor's actual configured account | Live continuation, exact replay and conflict refusal passed; no capacity benefit established |
| ChatGPT Work | Work account and tools permitted for the task | Work model and any delegated workers; record each setting separately | Shared Codex/Work usage under official guidance | Different experimental condition from ordinary Chat |
| Subscription-authenticated native Codex | Native client signed in with the operator's account | Native lead or worker; record model, effort and speed per role | Codex/Work allowance | Account-wide usage is visible; per-task consumption and concurrency must be reconciled |
| Sign in with ChatGPT, identity only | OpenAI identity consent linked to an o8 account | Account linking; no inference authorized by this grant | No inference allowance is granted | Separate proposed integration in #2951; not the hosted o8 tool grant |
| Sign in with ChatGPT, eligible plan inference | Identity plus separate plan-use consent and app caps | Eligible app inference; record selected model and settings | Existing Codex/Work allowance subject to caps | Not activated in o8; missing, revoked or capped permission must hold the request |
| Explicit API-authenticated inference | Separately authorized API credentials and project | API model at the configured settings | Configured API account/project | Existing route only; estimates, invoices and subscription allowance are distinct evidence |

The current hosted connection adds no separate paid-plan gate. An existing task
keeps its normal feature entitlements and usage enforcement. See the
[submission runbook](./openai-plugin-submission.md) for its capability boundary.

## What the installed path proves

The read handlers in [plugin-host.ts](../../src/lib/mcp/plugin-host.ts) read
durable task state and reports. They do not dispatch workers or call a model.
Follow-up dispatch is a separate handler with explicit scope, task selection,
audit and persisted retry binding.

The installed connected path has returned a retained worker's actual completion
report, while keeping its operator-review hold. A native MCP read has also run
without a model turn. These receipts prove reachability and the report behavior,
not the quota cost of a host conversation.

The earlier functional pilot completed one continuation without a duplicate on
exact retry. Its coarse account-wide usage observation overlapped other work.
Capacity attribution was inconclusive. An unchanged displayed percentage must
never be reported as zero consumption.

## Paired experiment

Use two fresh disposable repositories with identical starting contents and
repository instructions. Use the same bounded accepted task and worker
configuration in both conditions. Fix the task contract before either run.

1. Condition A uses ordinary Chat to plan, explain and send the explicit bounded
   follow-up through o8. Condition B uses the o8/Codex lead for the same task.
   Keep the worker model, effort, speed and permissions matched. Record planner
   settings independently; do not change saved defaults to manufacture a match.
2. Before each run, record account-wide allowance, window/reset timestamps,
   meter resolution, connected-app caps and any credit fallback setting. An
   unavailable value stays unknown. Never enable spending or change caps for
   this experiment.
3. Exclude concurrent work on every participating account, including the task
   conducting the comparison. Observe an idle control first. Establish the
   dashboard's reporting delay before attributing a before/after delta.
4. Include planning, dispatch, tool-result context, execution, reviews, polling,
   retries, reconnects and final acceptance. Count each model role once. Do not
   compare one condition's whole task with the other's worker alone.
5. Include a bounded interruption/context-recovery case and an operator-review
   hold. Both conditions must retain repository rules, task context and explicit
   permissions. Admission is not completion; completion is not approval.
6. Independently verify exact output, permitted diff, durable task/report state,
   attempts and any duplicate admissions. Reject a comparison if one condition
   changes the task, silently skips review or selects another payer.
7. Wait for the established reporting delay, then reconcile the usage windows.
   Repeat only when precision or a documented experimental defect warrants it.
   Missing meters or unexcluded concurrency make capacity inconclusive.

Record one private receipt per condition with these fields:

| Record | Required fields |
| --- | --- |
| Task contract | Starting state, exact expected output, owned files, repository rules, acceptance and operator hold |
| Route | Host surface, planner settings, worker settings, authentication class, executor roles, account/payer class and caps |
| Meter | Before/after values, window and reset, resolution, reporting delay, idle control and concurrent-work status |
| Execution | Start/end, admissions, attempts, tool calls, reviews, polling, reconnects and operator intervention time |
| Acceptance | Verified output/diff, persisted report and final status, correctness and residual defects |
| Decision | Documented rule, observed behavior, attribution confidence, unresolved visibility and next evidence needed |

Keep account identifiers, raw usage screens, machine details and credentials
private. Publish only the sanitized route matrix and decision. Token totals may
help explain context size, but cannot replace the account's allowance meter.

## Decision before a capacity claim

The supported current claim is: use ChatGPT to check o8 work and explicitly
continue an existing task. Status reads initiate no o8 model work; a continuation
uses its configured worker route. The phrase "without using your subscription"
is too broad for inference or a host conversation.

The comparison remains open. If the host does not expose attributable ordinary
Chat/MCP accounting, prepare an approved support question asking which usage
bucket applies and which meter can measure it. Do not infer a new allowance,
zero cost or automatic payer fallback from a successful connection.

## Related work

- [Connection, identity and plan-use consent](https://github.com/hurttlocker/o8/issues/3248)
- [Sign in with ChatGPT implementation](https://github.com/hurttlocker/o8/issues/2951)
- [Payer and permission visibility](https://github.com/hurttlocker/o8/issues/3250)
- [Paired usage comparison](https://github.com/hurttlocker/o8/issues/3251)
- [Connected plugin epic](https://github.com/hurttlocker/o8/issues/2955)
