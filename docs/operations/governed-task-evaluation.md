# Governed task evaluation

Status: protocol [#2290](https://github.com/hurttlocker/o8/pull/2290) is merged under [#2289](https://github.com/hurttlocker/o8/issues/2289). The formal paired pilot in [#2288](https://github.com/hurttlocker/o8/issues/2288) remains deliberately deferred for capacity. [#2296](https://github.com/hurttlocker/o8/issues/2296) is a separate incremental real-work dogfood round; no sample has started. This protocol does not authorize a run, release, restart, model trial, policy change, or product change.

## Purpose and boundary

The formal paired pilot asks whether the existing o8 workflow helps an operator finish correct, acceptable work with less active operator effort. It compares final task completion and operator effort. Initial-patch quality is a diagnostic, not the product claim.

[#1684](https://github.com/hurttlocker/o8/issues/1684) remains open and parked. Its first-diff research, original rule, and recorded results stay intact. The fresh tasks in this pilot are not its historical recurrence set. A future intervention study must declare its own question and protocol.

The formal paired pilot is a bounded decision aid, not a test of statistical significance or a population claim. It covers one governed task loop across the two tested runtime families. It does not establish multi-mission or fleet throughput, remote-operation benefit, or a general effect across tasks, operators, or runtimes.

## Incremental real-work dogfood

This observation round is separate from the formal paired pilot. Observe the next three suitable, already-authorized small engineering packets, one at a time as real work arrives. Record each selected task and packet before work begins. Do not manufacture tasks, use setup or protocol-writing as a sample, or select a task in advance solely to fill the round. A failure, hold, cancellation, or bypass remains an attempt.

Use each task's normal scope, worker, review, and delivery checks, and reuse their existing receipts. Normal repairs and necessary rechecks still belong to the real task. Do not add duplicate raw-agent baselines, extra model judges, broad tests, or telemetry solely for this round. Human minutes are recorded only when observed or supplied by the operator; unavailable measures stay unavailable. Account-wide quota changes are not packet-specific usage.

### Per-packet receipt

- Task and packet links, expected outcome, scope and stop limits, source and build identity, and effective runtime evidence when available.
- Original state, final terminal outcome, resulting revision, review and check evidence, and any lost or preserved work.
- Interventions by actor, their reason and result, plus observed friction or useful workflow behavior.
- Elapsed and waiting time, attributable usage when available, and human minutes only when observed or supplied.

Review the first three attempts together, or stop earlier for a material failure or capacity limit. A partial round preserves its receipts but does not prove a controlled effect. Fix findings through the normal issue and pull-request process between packets, record the change, and do not rewrite earlier outcomes or pool changed versions into a causal claim.

This round records reliability and friction on the observed tasks and guides fixes. It does not establish savings against another workflow or improve [#1684](https://github.com/hurttlocker/o8/issues/1684)'s first-patch result.

## Comparison design

This and the remaining sections define only the formal [#2288](https://github.com/hurttlocker/o8/issues/2288) pilot. Its sealed manifest, fixed workflow, and decision rubric do not restrict normal fixes between #2296 packets.

Use three fresh tasks and two established runtime families. Each task and runtime combination is one pair, for six pairs and twelve initial workflow runs.

Declare the fresh tasks before any attempt: one focused defect, one cross-file requirement, and one modest scoped feature. Each task must fit the 30-minute cap, have unambiguous behavior checks, and use a disposable repository and target. Exclude voice, virtual-machine, remote-operation, and production tasks before outputs exist, and record each exclusion with its reason.

| Arm | Workflow |
| --- | --- |
| A | A capable coding agent with its native tools and normal project checks. |
| B | The same coding runtime and settings through the existing o8 workflow. |

Use no new coding policy or strategy. The baseline keeps its normal useful tools and checks. The o8 arm uses existing task, review, repair, and recovery mechanisms, which the evaluator inspects but does not change.

Each arm has the same task, base revision, effective coding settings, permissions, consent, disposable-target rules, resource ceiling, and 30-minute total cap for coding and repairs. Each workflow run permits at most two repair cycles. Review and waiting time are measured separately from that cap. Count B's orchestration and reviewer use as part of B's usage and overhead. Neither arm can merge to production or release software.

Counterbalance arm order and task/runtime order as declared in the manifest. The human operator cannot be blinded to the workflow or interface condition. Record task and workflow familiarity, learning and order bias, the human participant, evaluator, and other evaluator or tool limitations. Independent final patch and behavior review can be blinded where practical.

## Freeze before collection

Before the first measured attempt, publish or retain a sealed run manifest that lists:

1. Exact tasks, source bases, acceptance checks, and observation window.
2. Code and build identities, initial source hashes, and the intended final revision record.
3. Actual runtime, model, and effort evidence, or an explicit unavailable value.
4. Arm order, counterbalancing, the human participant, evaluator, and resource limits, including a total review and evaluator-time ceiling and a usage ceiling.
5. Permissions, consent requirements, allowed repair cycles, the 30-minute cap, and the decision rubric.

Do not replace an assigned normal run. Include every assigned run, failure, hold, and terminal state in the operational denominator. Label a protocol-invalid sample and retain it; do not substitute a new task or rerun it until the result looks favorable. Preserve every first attempt. During a sealed pilot, do not repair the runner or change policy. No work outside the coding cap is unbounded: review, evaluator time, and usage stop at their manifest ceilings.

## Evidence for each run

Record initial and final source and diff hashes, the reviewed source revision, run logs, and the true terminal outcome. Completion requires approved integration into the disposable target and sealed acceptance checks on the resulting commit. Review-ready work is an intermediate state. Verify final behavior through the relevant entry point. An independent assessor judges requirement coverage and final acceptability; a worker assertion, citation, or self-report is insufficient. Use blinded patch assessment where practical.

Record these measures separately:

- active operator supervision, status, and navigation time;
- human review time;
- human corrective intervention time and cause;
- required consent and clarification time;
- automated or model-operator work;
- waiting time;
- elapsed time; and
- attributable usage and capacity limits.

The first four categories are mutually exclusive and counted once as total active operator time. Use that inclusive total for aggregate, median, and paired comparisons. Review and corrective intervention remain secondary diagnostics. Record study administration and measurement overhead separately; do not assign it silently to either arm. Do not invent dollar costs from subscription capacity. Missing usage prevents a complete cost claim. Missing human participation prevents a claim that the workflow saved human time. Count effort across every assigned run and preserve the time consumed by failures and holds. Record false blocks, false closes, failed checks, repairs, holds, and unresolved requirements with their true terminal state.

## Recovery evidence

Reuse an existing receipt only when it matches the runtime, signed identity, and reviewed revision. If no matching receipt exists, mark recovery evidence missing. Before collection, the manifest may declare at most one bounded interruption case per runtime in disposable test state. Count those cases separately from the twelve normal attempts.

Do not restart the daily app or touch held lanes, remote machines, virtual-machine work, or voice work. Formal collection remains deliberately deferred until the operator confirms timing and a frozen total usage ceiling that preserves development capacity. Release completion, isolated resources, a frozen manifest, and an available human participant remain prerequisites. A fresh usage week alone does not authorize formal collection. Deferring collection is not an incomplete experimental result.

## Decision rule

Apply this order to the final decision:

1. A missing load-bearing measurement makes the result **incomplete**.
2. A material permission or false-close failure in Arm B is a **tradeoff or regression** and prevents a positive claim.
3. When conditions 1 through 6 below pass but Arm B has higher total elapsed time or usage, report a **tradeoff or regression**, not an unconditional supported result.

A result is **supported in this pilot** only when all of the following are true:

1. All six pairs have complete, usable paired observations.
2. All six Arm B runs reach independently verified acceptable completion.
3. Arm B has no material permission or false-close failure.
4. o8 loses correctness on no pair that Arm A finishes correctly.
5. Total and median measured active operator time are lower for Arm B.
6. At least four of six pairs show lower paired active operator time for Arm B.
7. Arm B has no higher total elapsed time or usage.

Report elapsed-time and usage tradeoffs separately. A higher-completion, lower-time mix that does not meet the full support rule is a disclosed tradeoff, not a positive claim.

The final decision can be **supported in this pilot**, **no observed benefit**, **tradeoff or regression**, or **incomplete**. An incomplete result is valid only after a sealed pilot reaches a predeclared stop with preserved receipts. A negative or incomplete result then closes this measurement; it does not require a positive result and does not change #1684's separate first-diff rule.
