# What o8 actually does: an honest benchmark

*First run 2026-06-01/02. Re-run and substantially rebuilt 2026-08-02/03 against v0.1.652.*

Hypothesis and scoring rules were committed before any measurement — see [the pre-registration](../internals/bench-2026-08-preregistration.md) and its amendments, both timestamped in git and both predating the data they govern. Read *What changed since June* before quoting any figure.

This document reports what we can defend. Where a track lost, it says so. Where a result was withdrawn, it says why. Two of our own prior figures are retired below, and one experiment is reported as unmeasured rather than quietly dropped.

---

## TL;DR

- **Coding.** A pre-edit task contract improves one runtime and not the other. Given a contract, Claude won all three tasks (two decisively); Codex split, and on one task the contract made its output decisively worse. The pre-registered bar — two decisive wins for *each* runtime — is **not cleared**.
- **Governance.** **10 of 10** planted defects caught, **0 of 10** clean diffs blocked, 0 inconclusive, across 20 committed fixtures anyone can re-run. This is the strongest evidence here.
- **Memory.** The Brain scores **0.34** against ripgrep's 0.09 and a no-context floor of 0.01 (N=38) — a 3.8× edge on a question set that cannot be guessed.
- **Speed.** No regressions. Warm TTFB 9 ms.
- **Shipped output.** **Not scored.** Six attempts, six harness faults of our own, no number. What we did observe directly is in Track 5, including the review gate rejecting a worker that misreported its own work.

**The honest one-liner is unchanged from June: o8 does not make models better coders.** What we can now say is narrower and better evidenced — a pre-edit contract measurably helps some models, and the merge gate catches what mechanical checks cannot.

---

## What changed since June, and what did not

**Two of the four tracks had silently stopped measuring anything.** The memory eval had been pointed at a directory that stopped existing when our own pre-launch privacy scrub rewrote the path on 2026-07-30; it reported a catastrophic regression that never happened. The governance track had never been automated at all. Both were found only because the benchmark was re-run, and both are fixed.

**Every figure from June is superseded.**

| June figure | Status |
|---|---|
| Coding: o8-governed won 0 of 3 | **Superseded, and June's number is unsafe** — it used a single judge family. See the self-preference finding below. |
| Memory: Brain 68.6% vs strong-grep 39.5% | **Retired.** The harness was broken and the answer key had drifted. Both rebuilt; new figures are not comparable. |
| Governance: 2/3 caught, 0/2 false alarms | **Superseded** by an automated N=20 run. |
| Speed | Holds. |

---

## The finding that matters most: judges prefer their own family

Before any result below is read, this has to be on the table.

We scored six diffs blind, with two judges from different model families. **Every judge rated its own family's diff higher. Six out of six.** One diff scored **4.00 from one judge and 8.75 from the other** — same code, same rubric, nearly five points apart on a ten-point scale.

Under a symmetric-bias assumption you would see 6/6 about 1.6% of the time. At N=6 that is suggestive rather than proven, but the effect is large enough that we now treat single-family judging as unusable.

**Two consequences we are eating publicly.** June's coding result used a single judge family, so it carries this bias unquantified. And a manual scoring pass run earlier in this same effort — by a judge from one of the families being scored — has a plausible bias explanation that cannot be ruled out. Both results are withdrawn rather than defended.

**The fix, and why the coding numbers survive it.** The 2×2 compares *raw versus contract-first within the same runtime*. Both diffs in every comparison come from the same model family, so there is no family for a judge to favour. That design is structurally immune to the bias that invalidated the cross-model comparison — and it shows: judges agreed on the direction of all six paired comparisons. A win now additionally requires that agreement, not just an averaged margin.

---

## Track 1 — Coding: does a pre-edit contract improve first-diff quality?

**Method.** Three real issues (#1065, #1144, #928) from base `1530f7099`, which is exactly version 0.1.252 — the same version June cites — with all three issues verifiably open at that commit and the base typechecking clean. Two runtimes × two treatments = four arms per task, twelve arms total, isolated worktrees, diffs blinded and scrubbed of authorship, scored 0–10 by two judges on correctness, scope discipline, robustness, and fit.

**Results** (averaged across both judges; judges agreed on direction in all six):

| Task | Codex raw → contract | Claude raw → contract |
|---|---|---|
| #1065 — MCP ABI re-exec | 6.0 → **7.5** (+1.5, decisive) | 3.0 → **7.8** (+4.8, decisive) |
| #1144 — lane reconciliation | **6.3** → 5.8 (−0.5, noise) | 5.4 → **6.9** (+1.5, decisive) |
| #928 — greenfield projection | **6.8** → 5.2 (−1.6, **decisive against**) | 6.7 → **7.2** (+0.5, noise) |

**Per runtime:** Claude — 3 contract wins, 2 decisive. Codex — 2 raw wins, 1 decisive win each way.

**The pre-registered product bar is not cleared.** It required at least two decisive contract wins for *each* runtime. Claude clears it; Codex does not.

Read plainly: a pre-edit contract is a large, reliable win for one model and a wash-to-negative for the other. On #928 it was decisively harmful. We are not going to average that into a single friendly number.

*Caveat: N=3 tasks. A win counts as decisive only when the averaged margin exceeds one point on a ten-point scale **and** both judges agree on direction.*

---

## Track 2 — Governance: does the gate catch what compilers cannot?

**10 of 10 planted defects caught. 0 of 10 clean diffs blocked. 0 of 20 inconclusive.**

Twenty committed, re-appliable fixtures. Every planted defect passes `tsc` and eslint while being genuinely wrong, across ten distinct failure shapes — an inert guard nothing reaches, a retry that duplicates ledger entries, a projection leaking state across repositories, a concurrency race, a swallowed error, an off-by-one partition boundary, a stale cache, and three more. The ten clean controls are realistic non-trivial diffs, not two-line no-ops.

Two of ten clean controls drew a **non-blocking** finding attached to an approve verdict. The harness counts that in a separate column from *blocked*, because reporting a "20% false-positive rate" when the gate rejected nothing would misinform.

**Harness properties that make the number worth something:** the reviewer sees only the task, criteria, and patch — never the manifest — and runs from an isolated empty repository. Tool use is forbidden; any tool call aborts the turn as inconclusive, and backends whose tool activity cannot be observed fail closed. Ground truth opens only after all reviews return. Fixtures are never adjusted after seeing a result.

An earlier, more flattering run of this track (3/3 catch) was **discarded rather than reported**, because the reviewer could potentially have read the fixture manifest.

*Caveat: N=20, single reviewer backend, single operator. Measures the AI review tier, not the human approval gate above it.*

---

## Track 3 — Memory: does the Brain beat grep?

The June figure is retired. Two independent problems broke it, both now fixed.

**The harness was measuring nothing.** All 38 cases hardcoded a repo path that does not exist on the machine, introduced by our own 2026-07-30 private-path redaction. Every condition was asked about a repository that was not there. The giveaway: strong-grep — which is ripgrep, with no relationship to the Brain — collapsed identically, scoring 0.00 on literal lookups where it had scored 100%.

**The answer key had drifted.** It described the repository as of 2026-06-01. Rebuilt case by case: **9 valid, 17 repaired, 12 replaced.** Every answer now carries file-and-line, commit, or table-and-row provenance. **No answer was generated by asking the Brain** — an answer key written by the system under test makes every future number circular.

| Category | Brain | naive-grep | strong-grep | blind | N |
|---|---|---|---|---|---|
| ownership | **0.30** | 0.12 | 0.00 | 0.00 | 5 |
| decisions | 0.45 | **0.46** | 0.03 | 0.00 | 5 |
| processes | **0.63** | 0.26 | 0.18 | 0.02 | 5 |
| incidents | **0.43** | 0.01 | 0.20 | 0.00 | 5 |
| specs | **0.33** | 0.03 | 0.04 | 0.00 | 5 |
| cross-repo | **0.26** | 0.18 | 0.00 | 0.00 | 5 |
| literal-lookup | 0.11 | **0.12** | 0.12 | 0.01 | 8 |
| **OVERALL** | **0.34** | 0.17 | 0.09 | 0.01 | 38 |

**The blind floor is the story.** A no-context model scores **0.01** here against 0.099 in June — the rebuilt questions cannot be answered from training data. Every condition scores lower as a result, so absolute numbers are not comparable to June in either direction. What *is* comparable is the ratio: June was a 1.7× edge over ripgrep; this is **3.8×**. On questions that can be neither guessed nor grepped, retrieval pulls further ahead.

**Two losses.** Naive grep edges the Brain on `decisions` (0.46 vs 0.45, inside noise). And **nobody wins literal-lookup** — 0.11 to 0.12 across the board. The rebuilt literal cases are likely over-specified; one verified example demands two exact five-element arrays plus two derived constants, so a partially correct answer scores near zero. That is a scoring artifact to fix before this row is quoted, not a Brain finding.

*Caveat: single operator, one judge family, 5–8 cases per category.*

---

## Track 4 — Speed

| Metric | v0.1.652 |
|---|---|
| Dashboard warm TTFB | **9 ms** |
| Dashboard cold TTFB | **12 ms** |
| Bootstrap warm total | **3 ms** |
| CLI status median | 233–353 ms |

No regressions. June's structural fix (boot request fan-out, −50% requests) has held. Speed is the floor, not the moat.

---

## Track 5 — Shipped output: NOT SCORED

**There is no score in this track, and we are not going to imply one.** What follows is what was observed while trying to produce it.

The question worth answering is not whose *first* diff is better. It is: take a real issue, have a raw model write a diff you merge on green, versus route the same issue through the governed pipeline — **which one ships better code?**

Path A (ad-hoc): a raw model writes a diff, merged on green. What ships is the first diff.
Path B (governed): the same issue goes through dispatch, review, refix, and the merge gate. What ships is whatever survives to review-approved.

The governed arm is scored at **review-approved**, not merged, because the human approval card is the product's intended behaviour rather than something to route around. Nothing is merged and nothing is approved by the harness.

**Six collection attempts produced no score.** Every failure was ours, not the pipeline's, and each was a different fault: a specification whose constraints could not both hold; a liveness probe that aborted a healthy run on one transient blip; leftover lanes blocking mission creation through a CLI that could not pass the parameter the error message demanded; a diff captured before review ran; a clean worker exit misread as a failure; and a recorded base commit that disagreed with the branch the pipeline actually diffed against. Two of those produced confident, wrong results before being caught — in opposite directions.

**What was nevertheless established, by direct observation on a real issue (#1679):**

- **The governed pipeline reaches an approved review.** Dispatch to approval took about ten minutes.
- **It self-corrects mid-flight.** The orchestrator detected that the worker's branch carried a polluted base and steered it — diagnosing, unprompted, the same harness fault that had taken three failed runs and a cross-model review for us to find.
- **Approvals are head-locked.** An approval was recorded, the agent committed again, and the system invalidated its own approval rather than let it outlive the code it covered. Re-review then approved the settled state.
- **The review gate caught two things a compiler cannot.** On one packet it rejected a worker that had written notes claiming it bundled a dependency and passed five tests, while committing nothing but the notes. On another it rejected a plausible, well-scoped refactor with the finding that it did not actually fix the issue.

Those last two are worth more than the number this track was meant to produce. Track 2's 10-of-10 comes from fixtures with defects we planted ourselves. This is the gate catching a live worker misreporting its own work, and a wrong fix that passed `tsc` and eslint, on real issues, unprompted.

**What none of it establishes** is the comparison this track exists for: whether the governed path ships *better* code than an ad-hoc one. That requires a scored artifact from both paths, and we do not have one. The track stays open.

---

## Methodology integrity: how this benchmark can lie to you

A benchmark that only reports results is hiding half its failure modes. Ours failed four times in ways that had nothing to do with the product, and two of those produced *plausible-looking numbers* before we caught them. What follows is what broke and what now prevents it, because a reader has no way to audit this from the outside.

**We could not distinguish "I failed to measure" from "I measured a failure."** A backend process died partway through a run. The harness kept feeding arms to a dead service and recorded them as pipeline failures. The resulting output looked exactly like a product losing — and was reported internally as such — when in fact every arm had completed successfully, with committed diffs sitting on disk the whole time.

The fix is a three-outcome contract rather than two, modelled on the validity handling in the open-source [Codex CLI](https://github.com/openai/codex) (Apache-2.0), which solved this problem before we hit it:

| Outcome | Condition | Is it a measurement? |
|---|---|---|
| **valid** | terminal event observed, status success | yes |
| **failed** | terminal event observed, status failure | **yes** — the model tried and lost; scored and reported |
| **invalid** | **no terminal event ever observed** | **no** — never reported as a result |

Interruption is not failure. Classification is an exhaustive switch with no wildcard arm, so a new failure mode fails typecheck rather than being silently misfiled.

**We treated a live event stream as the record.** It isn't; it can drop messages under load, and it can stop entirely when a process dies. Every arm is now reconciled against durable state — persisted lane rows and the packet worktree on disk — after the fact. Durable state wins on disagreement and the receipt records the disagreement. Verified against the three arms a previous run declared dead: all three recover to valid with their diffs intact.

**The harness could drive a different CLI build than the repository it recorded.** The governed arm now resolves its control CLI once during preflight: `O8_BENCH_O8_CLI` when explicitly set, otherwise `cli/dist/o8.mjs` when that repo artifact exists, otherwise `o8` on `PATH`. The receipt records the canonical path and selection source, and preflight requires the CLI to advertise the `--existingBranchPolicy` capability; it also says plainly when the repo artifact is missing and a PATH fallback is selected. This makes CLI selection auditable, but it does not prove that an existing repo artifact was freshly built from the recorded commit, so `baseCommit` still describes the repository under test rather than automatically identifying the binary driving it.

**Other integrity properties.** Run IDs are immutable — the harness refuses to overwrite an existing receipt, so a result cannot be quietly re-collected after someone sees it. Approval mode is flipped only as a safety guard so nothing can auto-merge mid-run, and it is restored through a layered path that survives the backend dying. Blinding is verified by scanning each diff for authorship markers before judging, and judging fails loudly if any survive.

**What this does not fix.** These guards make invalid runs *visible*; they do not make small-N results large. Every caveat in the Limitations section still stands.

---

## What o8 is — and isn't

**o8 is not a better coder.** Two model generations after the first benchmark, the wrapper still does not reliably improve raw output. For Claude a pre-edit contract helps substantially; for Codex it does not, and sometimes hurts.

**What the evidence supports:**

- **Safe** — 10 of 10 subtly broken diffs caught with zero clean work blocked, on fixtures anyone can re-run. This is the claim the product rests on and the best-evidenced one here.
- **Informed** — a 3.8× edge over ripgrep on organizational questions that cannot be guessed or grepped.
- **Fast** — measured, version-stamped, no regressions.

**What the evidence does not support:** that the governed path ships better code end to end. That is Track 5, it is unscored after six attempts, and we would rather say so than imply it. The observations recorded there — the gate rejecting a worker that misreported its own work, the orchestrator steering itself off a polluted base, approvals invalidating when the code moves — are real and directly witnessed, but they are anecdotes from a broken harness, not a measurement.

---

## Limitations

1. **Small N throughout** — 3 coding tasks, 38 memory questions, 20 governance fixtures. Point estimates, never rates.
2. **Single operator, single machine.**
3. **Judge self-preference is real and measured.** Cross-model comparisons are withdrawn. The paired coding design is structurally immune; memory and governance still use a single judge family and inherit unquantified risk.
4. **Governance measures the AI review tier**, not the human gate above it.
5. **Memory literal-lookup cases are probably over-specified**; that row should not be quoted until re-checked.
6. **Shipped output is unscored.** Track 5 has produced no number in six attempts. Its observations are witnessed anecdotes, not measurements, and should be quoted as such.
7. **We benchmark the product we run on.** Mitigations: pre-registration committed before measurement, sealed blinding, published losses, discarded runs when blinding was compromised, and the validity contract above.

---

## Reproducibility

- Pre-registration and amendments: [`docs/internals/bench-2026-08-preregistration.md`](../internals/bench-2026-08-preregistration.md)
- Automated tracks: `npm run bench:speed` / `bench:memory` / `bench:governance` → version-stamped scorecard with regression detection
- Coding: `npm run bench:coding`; fixed tasks in `tests/bench/coding/tasks.json`; base `1530f7099`
- Governance fixtures: `tests/bench/governance/` — twenty committed diffs, re-appliable individually
- Harness validity contract: `scripts/bench/coding-arm-outcome.ts`, `scripts/bench/coding-durable-reconciliation.ts`, `scripts/bench/coding-run-control.ts`

---

*A benchmark that shows the product losing three sub-contests, withdraws two of its own prior results, and documents four ways its own harness lied is, we think, more useful than one that only ever flatters.*
