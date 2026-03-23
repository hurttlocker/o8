# Cortex AutoResearch Smoke Session — 2026-03-23

## Scope

This was a single-loop on-demand smoke session against the latest clean `main` of the sibling Cortex repo.

- Cortex repo commit: `a47a121`
- Binary built from clean detached worktree at `origin/main`
- Session shape: `1` loop
- Dataset: public LoCoMo `locomo10.json`
- Corpus: full 10-conversation markdown render
- Scored slice: `conv-30` smoke subset of `3` answerable questions from categories `1`, `2`, and `4`

## What Ran

### Import

Command:

```bash
/tmp/cortex-autoresearch-main-bin \
  --db /tmp/cortex-autoresearch-session1/cortex.db \
  import /tmp/cortex-autoresearch-session1/corpus \
  --recursive \
  --extract \
  --no-enrich \
  --no-classify
```

Observed result:

- import completed successfully
- `501` memories imported
- `3749` rule-only facts extracted before lifecycle cleanup
- `3686` facts visible in `stats`
- duration: about `13.8s`

This matters because earlier Cortex notes said `main` had produced an empty DB during a fresh LoCoMo import in this environment. That did **not** reproduce in this smoke session with the current corpus rendering.

### Synthesis path

Initial `ask` runs using:

```bash
--model google/gemini-2.5-flash
```

all degraded with:

- `reason: "no_llm_configured"`

That turned out to be a model resolution issue for this machine's provider-only config, not a general `ask` failure.

Working form:

```bash
--model openrouter/google/gemini-2.5-flash
```

Also verified:

```bash
--model openrouter/google/gemini-2.5-pro
```

## Smoke Results

### Retrieval

Top-5 evidence hit on the `3` smoke questions:

- `2 / 3` evidence hits

Per question:

1. `When Jon has lost his job as a banker?`
   - evidence hit: yes
   - top section: `Session 1 - 4:04 pm on 20 January, 2023`

2. `When Gina has lost her job at Door Dash?`
   - evidence hit: yes
   - top section: `Session 1 - 4:04 pm on 20 January, 2023`

3. `How do Jon and Gina both like to destress?`
   - evidence hit: no
   - top section: `Session 2 - 2:32 pm on 29 January, 2023`

### `ask` with working model

Model:

- `openrouter/google/gemini-2.5-flash`

Results:

1. `When Jon has lost his job as a banker?`
   - answer: `Jon lost his job as a banker yesterday, as of January 20, 2023 [1].`
   - degraded: no
   - note: close but not normalized to the expected `19 January, 2023`

2. `When Gina has lost her job at Door Dash?`
   - answer: `Gina lost her job at Door Dash in the month of January 2023 [1]. She also mentioned losing her job at Door Dash in March 2023 [4].`
   - degraded: no
   - note: contains the expected month but adds extra evidence/noise

3. `How do Jon and Gina both like to destress?`
   - answer: `Jon finds his happy place and expresses himself through dancing [4]. Gina also loves spending time in the dance studio and finds dance to be a cool way to express herself [4].`
   - degraded: no
   - note: directionally right, but retrieval missed the exact cited turns and answer form is paraphrastic

## What This Session Taught Us

1. The latest clean `main` baseline is importable in this environment.
2. The on-demand loop should fail fast on model-resolution problems and record them as setup errors, not silent benchmark degradations.
3. For this machine's current provider-only configuration, the session config should use fully qualified model IDs such as `openrouter/google/gemini-2.5-flash`.
4. Even in a tiny smoke slice, the current product path still shows the same pattern as the larger LoCoMo notes:
   - retrieval can find the right neighborhood
   - temporal answers stay relative/paraphrastic
   - commonality/composition questions are weaker than straightforward single-turn temporal retrieval

## Immediate Follow-up

- keep `quality_mode` provider-aware in the session config
- add a preflight check that validates model resolution before scoring
- add a real question scorer so these smoke sessions produce structured `keep` / `discard` outputs automatically
