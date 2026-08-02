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
