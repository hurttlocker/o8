# Pre-registration — o8 benchmark re-run, August 2026

**Written before any measurement was taken.** Committed first so the rubric cannot
be adjusted to fit the outcome. If any part of this is changed after a number is
seen, the change and its reason must be recorded in a "Deviations" section below,
not silently edited.

Baseline being re-tested: *"o8 — What It Actually Does (Honest Benchmark)"*,
2026-06-01/02.

## The question

Since June we added skills, changed dispatched-worker briefs, added the
adversarial review protocol (four forced traces before approval), and changed the
underlying models. Any of those could plausibly improve **first-diff quality**,
not just catch-rate.

> **Does o8 now make the models write better code, not just make merges safer?**

## Hypotheses, stated before the run

- **H1 (primary, coding).** o8-governed first-diff quality is *not* better than
  raw Codex or raw Claude. June: o8-governed won **0 of 3**. Predicted August:
  still 0–1 of 3. I expect this to remain **no**.
- **H2 (governance).** o8's review tier still catches more bugs than merge-on-green.
  June: **2/3** caught (3/3 in a reconstruction-based re-audit), **0/2** false
  alarms. Predicted August: ≥2/3 catch, ≤1 false alarm.
- **H3 (memory).** Brain overall accuracy holds within run-to-run noise of the
  0.1.252 run of record (**68.6%** Brain vs **39.5%** strong-grep). Predicted:
  Brain within ±6 points, still ahead of strong-grep by ≥20 points.
- **H4 (speed).** No regression against the previous release scorecard.

**What would change the headline claim.** H1 is falsified — and the June doc's
central finding retired — only if o8-governed wins **≥2 of 3** tasks on blind
judging *and* the margin is more than one point on the 0–10 scale. A 1-point edge
on one task is noise at this N and will be reported as noise.

## Scoring rubric (fixed now)

Each diff scored **0–10** by a judge that is not told which condition produced it.
Sub-scores, equally weighted:

1. **Correctness** — does it actually do what the issue asked, on the real code path?
2. **Scope discipline** — every changed line traceable to the request; no
   unrequested refactor, no missed sub-requirement.
3. **Robustness** — error paths, edge cases, no state leaks across repos/sessions.
4. **Fit** — matches surrounding conventions; would pass review in this codebase.

Mechanical gates recorded separately, never folded into the judge score:
`npx tsc --noEmit` and `npx eslint` on changed files, pass/fail.

**Blinding procedure.** Diffs are written to files named only `A`, `B`, `C` per
task, with a shuffled mapping stored outside the judging context. Author-revealing
markers (worktree paths, branch names, commit trailers, agent chatter) are stripped
before judging. The mapping is opened only after all scores are recorded.

**Best-shot rule for the cheaper alternative.** Raw Codex and raw Claude get the
same issue text, the same clean base, and the same "make it correct and minimal"
framing that o8's worker brief provides. No handicap, no truncated context. If the
raw arm is disadvantaged by the harness in any way, that is a finding to report,
not a result to keep.

## Reporting rules

- Every figure carries its **N**. Point estimates, never rates.
- Anything reconstructed, proxied, or re-derived rather than measured live is
  labelled as such at the point of use.
- **Every sub-contest o8 loses is reported.** A clean sweep is treated as evidence
  of a broken method, not a good product.
- Three failed attempts on any track → stop, revert, report the blocker. A partial
  run with an honest gap beats a complete run with a filled-in guess.

## Known threats to validity, noted in advance

- **The base moved.** o8's git history was rewritten 2026-08-01, so June's base
  commit SHAs no longer exist. Content is preserved; the equivalent tree must be
  located by content and that substitution disclosed.
- **The judge and the subject share a model family.** Same limitation as June.
- **I am benchmarking the product I am running on**, which is a conflict of
  interest no amount of procedure fully removes. The mitigations are pre-registration,
  blinding, and publishing losses.

## Deviations from this plan

*(Any change after the first measurement gets recorded here, with the reason.)*

---

## Deviations (recorded after measurement began)

1. **Judging fell back to the orchestrator.** Four independent subagent judges were
   spawned; all four completed analysis and failed to return a report — a harness
   failure past the stated three-attempt bound. Scoring was done by the
   orchestrating model with the condition mapping still sealed and unopened.
   Blinding held mechanically; model-family independence did not. Disclosed in the
   document.
2. **A blinding leak was attempted and failed.** Having read the governed arms'
   review summaries earlier in the session, the orchestrator inferred that a
   specific #1144 diff was o8's and scored believing it. On unsealing the
   inference was wrong (it was Codex-alone). Recorded rather than omitted.
3. **The memory harness was repaired mid-run.** `tests/qa-eval/cases.json` hardcodes
   a repo path that does not exist on this machine, so the first run measured
   nothing. The runner now resolves a real checkout at run time. The questions and
   expected answers were NOT changed. A second, unrepaired problem — drifted ground
   truth — means the track still yields no quotable figure.
4. **Governance track not run.** Reported as a gap, not reconstructed.

## Outcome vs prediction

- **H1 (o8 does not improve first-diff quality): held.** Predicted 0–1 of 3;
  actual **0 of 3**. The falsification bar (≥2 of 3 with >1 point margin) was not
  approached.
- **H2 (governance catch rate): not tested.**
- **H3 (memory holds within noise): could not be tested** — harness invalid.
- **H4 (no speed regression): held.**

---

## Amendment 2 — final run (recorded before any new data)

The 2026-08-02 collection produced **0 scored tasks**: all six contract arms were
invalidated because the harness looked for the contract in the worker's final
reply, while the instruction asks for it mid-turn and the transport retains only
final replies. **The intervention was never observed. It was not measured and
found wanting**, and no claim about contract-first may be drawn from that run.

Judging the six valid raw arms then surfaced a method defect that matters more
than the result:

> **Across six judgements, every judge scored its own model family's diff higher.
> Six for six.** One diff scored 4.00 from one judge and 8.75 from the other — a
> 4.75-point spread on identical code.

Under a symmetric-bias assumption, 6/6 self-preference occurs by chance about
1.6% of the time. At N=6 that is suggestive, not proven, but the effect size is
large enough that single-family judging cannot be trusted.

**Two consequences recorded honestly.** The June benchmark used a single judge
family, so its coding result carries this same unquantified bias. And the manual
scoring performed earlier in this session was done by a Claude-family judge that
scored Claude-alone as winning two of three — that result has a plausible bias
explanation which cannot be ruled out. Both are now suspect.

### Changes for the final run

1. **Contract observability moves to a file artifact.** The contract arm writes
   `task-contract.json` to the worktree; validity is decided by parsing that file
   with the production parser, requiring at least one requirement and every
   requirement id mapped in `smallestRoute`. Malformed or empty stays invalid.
   The file is excluded from the judged diff.
2. **A decisive win now requires judge agreement.** Both the averaged margin must
   exceed `NOISE_MARGIN` **and** both judges must agree on the direction. Where
   they disagree, the task reports `judges disagree` rather than averaging into a
   winner.

Rule 2 is strictly harder to clear than the original bar. It is recorded here,
before the run, because a scoring rule changed after seeing results is not a rule
— and applied to the data already collected, it would have produced **zero**
decisive wins rather than one.

Nothing else changes: same three tasks, same base, same 2x2 design, same
`NOISE_MARGIN`, same immutable run IDs, same requirement to publish every loss
and every invalid arm.

---

## Amendment 3: shipped-output experiment (recorded before collection)

The first-diff experiment remains intact, but it does not measure the governed
pipeline's merge-safety claim. A second experiment in the same immutable run now
scores the artifact that would ship through each path.

The tasks are exactly issues #1676, #1678, and #1679. Each task starts from the
same full `main` commit recorded in the collection receipt. The arms are
`adhoc-codex`, `adhoc-claude`, and `governed`. The ad-hoc artifact is the model's
single-pass diff. The governed artifact is the packet diff only after the real
mission dispatch, auto-review, autonomous refix, durable approval, and read-only
merge preview reach `wouldMerge=true`. The harness never calls merge or any
operator approval command.

Collection refuses to start unless the operator's existing approval posture is
`always`. Auto-review normally attempts a merge after recording its verdict, so
this fixed safety interlock holds the real pipeline at the final approval boundary
without racing it, changing settings, or approving on the operator's behalf. A
governed arm is invalid if it stalls, asks for a human decision before becoming
merge-ready, releases instead of holding, produces a truncated or empty diff, or
reports a merge base different from the recorded commit.

Before judging, the harness removes task-contract, implementation-note, and
review-artifact patches, replaces recorded worktree, mission, packet, lane, worker,
and branch provenance, then scans the blinded diff for both exact and generic
markers. Any surviving marker aborts judging. The same two judges and rubric score
all three shipped diffs. A winner is decisive only when its averaged margin exceeds
`NOISE_MARGIN` and both judges independently rank it above every other arm;
disagreement is reported as `judges disagree`. Every invalid arm and every governed
loss remains in the receipt and report.

---

## Amendment 4: Track 5 terminal-failure result and judging incident record

This amendment is recorded after collection and before publication. It discloses
the execution environment and two pre-score harness repairs; it does not change
the collected artifacts, task, rubric, seed, noise margin, or decision rule.

Run `e2e-track5-1679-v8` selected only issue #1679 and recorded base
`b9fa7c98242de0589fa83d88503a0b7d3f05da47`. Collection ran against a clean
temporary clone of that `origin/main` because the primary checkout contained
committed harness repairs that were not all on the remote. The rebuilt repository
CLI was supplied through `O8_BENCH_O8_CLI`, and its canonical path and override
source are in the receipt.

The three-outcome contract supersedes Amendment 3's older statement that every
stalled or empty governed arm is invalid. A terminal state observed as failure is
`failed`, scored, and reported. Only the absence of a terminal state is `invalid`
and excluded. This switch and the durable convergence wait were implemented and
tested before this collection.

The collection produced two valid ad-hoc arms and one failed governed arm. The
governed lane entered `launching`, was durably archived as `no_changes` when its
untouched branch equaled `origin/main`, and then recorded worktree provisioning
failure. No worker or review ran. The same clean-base typecheck passed directly in
about 50 seconds; the dispatch log records a 30-second headless deadline. The
result therefore retains an empty governed artifact as an observed pipeline
failure rather than reclassifying it as invalid or recollecting the task.

The first judging attempt stopped before spawning a judge because an unchanged
product comment containing `~/.o8/` matched an artifact-path marker. Artifact
markers are now checked only in `diff --git` path headers, while exact and generic
provenance markers are still checked throughout the blinded diff. A regression
test covers both the allowed product-body path and excluded artifact path.

That pre-score exception had already written an empty judging progress receipt.
The runner now validates every blinded input before creating a new receipt and may
resume an existing receipt only when it belongs to the same run and contains zero
judge receipts and zero verdicts. Its original `startedAt` is preserved. Any
receipt containing one result remains immutable. No judge had seen a candidate
and no score existed when these two repairs were made.

Both blinded judges then completed validly. The averages were 6.3 and 8.6 for the
two ad-hoc arms and 0.0 for governed. Both judges agreed on direction; the winning
margin over the runner-up was 2.3, above `NOISE_MARGIN=1`. This is an N=1 decisive
end-to-end governed loss. Because the governed arm failed before review, it is not
evidence about review-and-refix quality conditional on successful dispatch.
