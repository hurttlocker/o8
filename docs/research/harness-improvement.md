# Offline harness improvement foundation

This tooling admits supplied proposals for optional context notes and analyzes supplied probe receipts. It does not generate proposals, run probes, install prompts, change component lifecycle, or establish real-work benefit. Reports are advisory data. A valid report is not approval, and a supplied digest is an identity check, not proof that a trusted verifier ran.

Tracking: [offline foundation milestone](https://github.com/hurttlocker/o8/issues/3985), [proposal admission](https://github.com/hurttlocker/o8/issues/3986). The milestone has a fixed 100-point acceptance denominator. Completion of that milestone does not complete broader adaptation, release acceptance or live benefit validation.

## Existing seams and ownership

Inventory baseline: o8 `b1542752610099c55e72296e313e8556596283f9`.

- `src/lib/harness/types.ts`, `bundle.ts`, `store.ts`, `service.ts` and `docs/user/self-tuning-harness.md`: reuse the exported bundle and accepted contract identity. Do not duplicate the existing grounding, sprint, evaluator, persistence or CLI/MCP control plane.
- `src/lib/harness/lift-store.ts`: existing model/component measurements and explicit lifecycle, shipped under #1204/#1660. Its supplied scores are not authenticated scientific observations. Bundle measurements/components are global rather than repository-specific; this tool deliberately does not use them as paired task evidence.
- #2481: typed judgment remains subject to deterministic-first, native-runtime-duplication and independent replay gates. A model recommendation is not truth or permission.
- #2221/#2220: correction retrieval and selective forgetting retain their existing ownership. This tool does not write Brain memory.
- #3184/#3187: intent and shadow decisions remain separate. No router changes.
- #2289: formal paired pilot remains paused. No new collection, paid inference or comparative savings claim is authorized by fixture tests.

## Usage

Create a disposable bundle export using the existing `o8 harness export` workflow only when authorized for that data. Supply a manifest and proposal array. Freeze the canonical manifest SHA-256 independently before comparing proposals.

```sh
node scripts/harness-improvement.mjs \
  --bundle bundle.json --manifest manifest.json \
  --manifest-sha256 <frozen-canonical-sha256> \
  --proposals proposals.json --evidence evidence.json --out new-report.json
```

Canonical JSON recursively sorts object keys, preserves array order, and has no whitespace. `contractDigest` hashes only `{generatorTerms, evaluatorTerms, acceptanceCriteria}` using the same canonicalization. A complete deterministic fixture is in `tests/fixtures/harness-improvement/admission.json`; its `PLACEHOLDER` contract digest is intentionally filled by the test from those terms.

The manifest binds repository, accepted contract, baseline revision, model/runtime, verifier and permission digests, attempt/dollar bounds, disjoint discovery and held-out task IDs, and allowed context-note component IDs. Proposal evidence can reference discovery tasks only. Component IDs are identifiers, not filesystem paths. Only inert `context_note` text is accepted; scripts, hooks, plugins, guardrails, runtime settings and permission edits are outside the surface. The tool never interprets or executes note text, even when it contains instructions.

Inputs must be regular files no larger than 2 MiB and must not resolve through symlinks. Reports use exclusive creation and private file mode. Existing output and input files are never overwritten. The report includes content digests and omits note bodies. Without `--evidence` it reports admission only and says `KEEP_BASE`. With evidence it can name one already-tested candidate for operator review; it never unions untested changes. Malformed inputs produce no report. This is a local artifact workflow, not a new service or database.

The operator who supplies the manifest must independently establish that its accepted contract, baseline and frozen verifier/permission digests describe the intended experiment. This offline tool does not inspect an installed app or authenticate signed receipts.

## Research provenance and licensing disposition

Inspected [Harness²](https://github.com/google-research/harness2) at commit [`1cfe254e8d25b15f37048c3730134686abe60335`](https://github.com/google-research/harness2/tree/1cfe254e8d25b15f37048c3730134686abe60335), accompanying [paper](https://arxiv.org/abs/2610.14224), and these actual source seams:

- `harness2/core/tree.py`: `SurfaceSpec`, `normalize_rel`, `validate`: explicit editable surface and bounded validation. Here the surface is narrower, non-executable context-note data only.
- `harness2/core/recursion.py`: `_accept_tree`, `_run_stage`: validate proposals and preserve baseline on invalid results. This tool does not launch upstream recursion or retries.
- `harness2/core/context.py` and `prompts.py`: separate task evidence from grader verdicts and treat trajectories as untrusted context. Here task partitions are explicit and note text stays inert.
- `harness2/core/selection.py`: `_fallback`, `run_selection`, `_distil`: baseline fallback, comparison and evidence-linked lesson concepts. No model selector or model-generated truth is imported.
- `harness2/core/ledger.py`: tracked attempts/cost. Selection and reflection sit outside its rollout ledger; the o8 receipt analysis includes them explicitly rather than claiming rollout cost is all-in cost.
- `harness2/core/library.py`: `Library.retain`, `add`, `root_for`, and `schedule.py`: task/domain/run-scoped lessons and prior-task-only context. No filesystem deletion or universal experience store is imported.

The upstream root license and core source headers are Apache-2.0, Copyright 2026 Google LLC. No separate NOTICE file was present in the pinned tree. `third_party/README.md` and `dependencies/README.md` identify separately licensed runners, patches and datasets, including custom WorkBuddy terms with a territorial limitation. Those assets, datasets, prompts and executable code are not copied or installed here.

This is original o8 code implementing selected concepts, not a line-by-line translation or vendored upstream module. Consequently this change introduces no upstream source files or new third-party dependency. Any later actual copy/translation must retain applicable copyright/license notices, include the license and mark changes, and review the specific asset's terms rather than assuming the root license covers everything.

Rejected upstream defaults include unrestricted executor network, disabled Codex sandbox, editable guardrails/AGENTS/hooks, model-judge selection as truth, and automatic recursive execution. Research provenance is not a security guarantee.

## Remaining broader adaptation

Supplied receipt comparison and scoped lesson filtering are part of this offline slice. Candidate generation, isolated bounded probe execution, application through existing operator-controlled seams, real held-out evaluation, installed acceptance and promotion remain separately scoped and held. None is implied by 100% offline fixture acceptance. Real-work benefit requires independent outcomes and complete costs, including failed attempts, proposal, probe, composition, selection, review, reflection and operator effort where applicable. Unknown cost cannot become zero or a savings claim.

## Supplied receipt schema and decision rule

The optional evidence object has exactly `schema` (`o8/harness-improvement-evidence/v1`), `manifestDigest`, `origin` (`fixture`, `manual`, or `observed`), `costComplete`, `runs`, `costs`, `lessonTargetTask`, and `lessons`. Origins and completeness are caller declarations, not authenticated observations. Every report says `receiptsAuthenticated: false` and `liveBenefitProven: false`, including a positive fixture result.

Each run has `id`, `taskId`, `variantId` (`baseline` or a proposal ID), `proposalDigest` (baseline revision for the control; canonical proposal digest otherwise), `modelId`, `runtimeId`, `baselineRevision`, `verifierDigest`, `permissionsDigest`, `budgetDigest`, `partition` (`discovery` or `held_out`), `status` (`completed`, `failed`, `inconclusive`), `score` (0–1 or null), `independent`, `verification` (`deterministic`, `human`, `model`), `evidenceRef`, and `costIds`. Run identity must match the frozen manifest. Duplicate task/variant pairs are rejected. Costs record retries even though each task/variant has one terminal outcome.

Every held-out task must have one complete, independent, non-model-only baseline/candidate pair for every proposed candidate. Missing, failed, dependent or inconclusive verification keeps the baseline. A candidate must improve mean supplied score, regress on no held-out task, and uniquely beat every other eligible candidate. Ties keep the baseline. This fixed conservative rule is software behavior, not statistical significance or a promotion threshold.

Each cost row has `id`, `variantId`, `stage` (`proposal`, `probe`, `compose`, `selection`, `review`, `reflection`), `usd`, `payer`, `tokens`, `wallMs`, `humanMs`, and nonnegative integer `attempts`. Dollar, usage, time and payer values can be null; null stays unknown. Every variant, including the baseline, needs every stage explicitly accounted for. A non-applicable non-probe stage uses a zero-attempt receipt with all numeric costs exactly zero; unknown cost cannot use that representation. Probe receipts require positive attempts. Probe entries must be allocated to exactly one matching run. All attempts and costs, including failed or rejected alternatives, count against the experiment budget. `maxAttempts` counts all stage attempts, not only final probes. Missing stages, missing cost allocation, incomplete cost declaration or unknown accounting prevents a recommendation. `knownSubtotalUsd` is explicitly partial and is never a total/savings claim. Times are per-stage supplied receipts, not an inferred wall-clock experiment duration.

Each lesson has `id`, `candidateId`, `repository`, the same five model/runtime/baseline/verifier/permission binding fields, `componentKey`, `sourceTaskId`, `sourceReceiptIds`, `expiresAfterTask`, `revoked`, and inert `text`. Discovery tasks precede held-out tasks in the manifest's declared order. Eligible lessons must match the exact scope and proposed component, cite independently verified completed discovery receipts from that candidate, precede `lessonTargetTask`, and remain unexpired and unrevoked. Excluded IDs remain visible. Output lessons are `data_only`; no lesson installs itself or changes permission. Filtering supplied lessons does not prove that learning transfers to future tasks.

The real-entry fixtures in `tests/harness-improvement-real-path.test.ts` construct complete examples, run the executable and assert baseline fallback, rejected malformed input, immutable output, costs and lesson exclusions. There is no online collection mode.

## Paper-to-implementation crosswalk and deliberate deviations

Reading [the paper's full text](https://arxiv.org/html/2610.14224v1) alongside the source:

- Section 2.2.1 holds model, environment and improvement harness fixed during a task. The manifest preserves explicit baseline/model/runtime/verifier/permission identities; it does not authenticate those supplied identities.
- Sections 2.2.1–2.2.2 generate, execute and compose successor harnesses. This milestone only admits supplied proposals and analyzes supplied receipts. **Selecting one tested candidate is not the paper's composition operation**: Section 4's no-composition ablation makes that distinction. Executing and verifying a newly combined successor remains held.
- Section 2.3 carries earlier experience into subsequent tasks. Our narrower lesson filter checks source order, scope, expiry and revocation without building or installing a persistent improvement library.
- Section 4 counts execution and improvement compute. Our ledger requires every stage and exposes unknown accounting rather than treating missing costs as zero.
- Appendix F cautions that extra refinement costs compute and behavioral/model feedback guarantees neither correctness nor transfer. We retain independent verification requirements, baseline fallback and an explicit unproven-live-benefit result.

Held-out comparison and operator approval are o8 constraints added to this offline adaptation, not claims that the paper's online method requires labeled ground truth.
