# GStack Audit for Cortex Agent Workflows

Date: 2026-03-22  
Workspace: `/Users/marquisehurtt/clawd/repos/cortex-ide`

Audited snapshots:
- `garrytan/gstack` @ `7ff0f84b1e37a792ef6127a91f8ba3f83e1e3913`
- `obra/superpowers` @ `8ea39819eed74fe2a0338e71789f06b30e953041`

Related prior work:
- `docs/research/superpowers-audit.md`

## TL;DR

GStack is the closest thing I have seen to a usable **agent sprint operating system**, but it is still not a workflow engine.

The strong parts are:
- a clear stage model: `Think -> Plan -> Build -> Review -> Test -> Ship -> Reflect`
- a real local artifact store under `~/.gstack/`
- persisted review/readiness state
- a strong `AUTO-FIX` vs `ASK` policy split
- the persistent browser daemon, which turns QA from “prompt theater” into a real tool

The weak parts are:
- no central state machine
- no first-class Build executor; “Build” is mostly implied between Plan and Review
- approval gates are still mostly prompt-enforced conversation rules
- Reflect is mostly observational and weakly fed back into future work
- multi-runtime support is packaging-level, not orchestration-level

For Cortex IDE, the right move is:

- **adopt GStack’s pipeline model as inspiration**
- **steal several primitives directly**
- **do not adopt GStack itself as the workflow foundation**

Cortex should build its own workflow control plane above the runtime adapter layer, then express GStack-like stage templates inside that engine.

## Methodology

I read the GStack repo’s top-level docs (`README.md`, `ARCHITECTURE.md`, `BROWSER.md`, `ETHOS.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/skills.md`, `TODOS.md`, `CHANGELOG.md`), all first-party skill definitions, the generated `.agents/skills/*` host-specific outputs, the helper scripts in `bin/`, the skill generator in `scripts/gen-skill-docs.ts`, and the routing / host E2E tests.

I also reviewed `obra/superpowers` again because the comparison matters here. The key files were `README.md`, `skills/using-superpowers/SKILL.md`, `skills/brainstorming/SKILL.md`, `skills/writing-plans/SKILL.md`, `skills/subagent-driven-development/SKILL.md`, `skills/executing-plans/SKILL.md`, `skills/requesting-code-review/SKILL.md`, `skills/finishing-a-development-branch/SKILL.md`, `skills/using-git-worktrees/SKILL.md`, plus the Codex/Gemini install docs and skill-triggering tests.

One important note: the generated `.agents/skills/gstack-*` files are mostly host-adapted copies of the source skills. I still checked them because the host packaging differences are architecturally important.

## 1. What GStack actually is

GStack is best understood as four layers:

1. **Prompt-packaged specialist skills**
   - Each role is a `SKILL.md` file with YAML frontmatter and long procedural instructions.
2. **A small runtime helper toolkit**
   - `browse` daemon, `gstack-config`, `gstack-review-log`, `gstack-review-read`, `gstack-diff-scope`, `gstack-repo-mode`, etc.
3. **A local artifact store**
   - mostly under `~/.gstack/projects/<repo-slug>/...`
4. **An external parallel-workspace story**
   - Conductor worktrees are how Garry runs “10-15 parallel sprints”; GStack itself is not the fleet orchestrator.

That means GStack is not:

- a typed DAG engine
- an event-driven job system
- a resumable background workflow runner
- a runtime-agnostic control plane

It is a very capable **skill-driven operating doctrine** backed by a few real persistence primitives.

## 2. Architecture Breakdown

### 2.1 Skill packaging and generation

GStack’s skills are generated from templates:

```text
SKILL.md.tmpl -> scripts/gen-skill-docs.ts -> SKILL.md
```

The generator injects:

- a shared preamble
- the shared `AskUserQuestion` format
- the “Boil the Lake” completeness doctrine
- prerequisite-skill offers derived from `benefits-from`
- browse command docs from source metadata
- review dashboard / test bootstrap blocks reused across skills

This is one of the better parts of the design. It avoids hand-maintained drift across 20+ large skills.

### 2.2 Skill format

Claude-hosted source skills use YAML frontmatter like:

- `name`
- `version`
- `description`
- `allowed-tools`
- sometimes `benefits-from`

Example structural pattern:

1. frontmatter for routing
2. generated shared preamble
3. shared question format / completeness doctrine
4. skill-specific workflow instructions
5. “run last” telemetry block

For Codex-compatible hosts, the generator writes `.agents/skills/gstack-*` variants:

- frontmatter is reduced to `name` + `description`
- Claude-specific paths are rewritten to `~/.codex/skills/gstack` and `.agents/skills/gstack`
- hook-based safety skills become inline advisory prose

Important implication: host adaptation is **prompt packaging**, not a capability layer.

### 2.3 Runtime helper layer

The real hard-tech part in GStack is `/browse`.

`ARCHITECTURE.md` and `BROWSER.md` describe a compiled Bun CLI talking over localhost HTTP to a long-lived Playwright/Chromium daemon. Key properties:

- persistent cookies / tabs / localStorage
- bearer-token auth
- `.gstack/browse.json` state file
- 30-minute idle timeout
- binary version restart when the built CLI changes

This is a real operational asset, not just prompt discipline. It is the clearest example of GStack crossing from “Markdown skill pack” into product substrate.

### 2.4 Shared support scripts

The small shell tools matter because they create the real continuity:

- `gstack-config`: reads/writes `~/.gstack/config.yaml`
- `gstack-review-log`: appends review JSONL to `~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl`
- `gstack-review-read`: reads review JSONL + config + HEAD commit for readiness dashboards
- `gstack-slug`: derives repo slug + sanitized branch key
- `gstack-repo-mode`: classifies repo as `solo` vs `collaborative` and caches result
- `gstack-diff-scope`: classifies frontend/backend/tests/docs/config scope from the diff

This helper layer is why GStack feels more stateful than most skill repos.

## 3. The Sprint Pipeline

The headline lifecycle is:

`Think -> Plan -> Build -> Review -> Test -> Ship -> Reflect`

In practice it maps like this:

| Stage | Primary skills | Notes |
|---|---|---|
| Think | `/office-hours` | Generates design docs and premise-challenge artifacts |
| Plan | `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/autoplan` | Strongest part of the system after browse |
| Build | implicit normal coding, `/investigate`, `/design-consultation`, safety skills | This is the big gap: no dedicated execution engine |
| Review | `/review`, `/design-review`, `/codex` | Includes adversarial review and optional cross-model passes |
| Test | `/qa`, `/qa-only`, `/benchmark`, `/canary` | `/qa` can fix bugs and generate regression tests |
| Ship | `/ship`, `/land-and-deploy`, `/document-release`, `/setup-deploy` | Has the best explicit readiness logic |
| Reflect | `/retro` | Mostly reporting and trend comparison |

### Important finding: Build is under-modeled

GStack markets a seven-stage pipeline, but only six are really first-class. Build is mostly “the agent codes after the plan and before review.”

That matters a lot for Cortex.

If we want “Agent Workflows” to mean autonomous multi-step chains, then the Build stage needs:

- explicit task decomposition
- execution ownership
- runtime selection
- retry budgets
- task status
- resumable checkpoints

Superpowers is better designed than GStack in this one specific area because it has a more explicit `plan -> worktree -> subagent execution -> review` discipline.

## 4. How skills chain

GStack chains skills in four different ways.

### 4.1 Description-based routing

Each skill description says when it should trigger. This is what skill-aware hosts use for automatic discovery.

### 4.2 Top-level proactive recommendation logic

Root `SKILL.md` maps conversational situations to skills:

- ideation -> `/office-hours`
- plan review -> `/plan-*`
- debugging -> `/investigate`
- testing -> `/qa`
- review -> `/review`
- shipping -> `/ship`

This is controllable via `gstack-config set proactive true|false`.

### 4.3 Artifact-aware prerequisite offers

`benefits-from: [office-hours]` is turned into a generated “Prerequisite Skill Offer” section for `plan-ceo-review`, `plan-eng-review`, and `autoplan`. If no design doc exists, those skills offer `/office-hours` first.

### 4.4 Explicit prompt-level composition

`/autoplan` is the clearest example. It literally:

- creates a restore point
- reads the other skill files from disk
- skips shared sections
- follows the review sections from `plan-ceo-review`, `plan-design-review`, and `plan-eng-review`
- auto-decides their `AskUserQuestion` branches using six decision principles
- stops at a final approval gate

This is both clever and revealing:

- clever, because it reuses the plan-review skills without copy-paste
- revealing, because it proves there is still **no underlying engine**; one prompt is interpreting other prompts

## 5. How phase activation works

GStack does not have a central “phase manager.”

Activation is distributed across:

- frontmatter descriptions
- host-native skill matching
- root-skill proactive recommendations
- artifact existence checks
- review/readiness logs
- diff classifiers
- skill-local prerequisite offers

Examples:

- `plan-eng-review` looks for a design doc in `~/.gstack/projects/...`
- `ship` reads the branch review log to determine readiness
- `plan-design-review` exits early when UI scope is absent
- `codex` auto-detects review vs challenge vs consult based on user phrasing and branch diff presence

The tests in `test/skill-routing-e2e.test.ts` validate that certain prompt patterns route to expected skills, but the routing is still fundamentally prompt-native.

### Bottom line

Phase detection is:

- better than “just vibes”
- worse than a real workflow engine

For Cortex, this should become a proper precondition system:

- user intent
- trigger type
- artifact presence
- prior stage outcomes
- runtime capability availability

## 6. Approval gates between phases

GStack has meaningful gates, but they are uneven.

### Stronger gates

- `/office-hours` hard-gates implementation until a design exists and the user approves it
- plan reviews use `STOP` + one-issue-at-a-time `AskUserQuestion`
- `/autoplan` uses a real final approval gate after auto-deciding intermediate steps
- `/land-and-deploy` has an explicit readiness confirmation step

### Operational gates

- `/review` separates findings into `AUTO-FIX` vs `ASK`
- `/ship` treats Eng Review as the only required gate by default
- ship review overrides are persisted per branch in `~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl`

### Weakness

Most gates are still represented as:

- prompt rules
- shell writes
- agent memory of prior conversation

They are not first-class approval objects with typed status and UI surfaces.

### Cortex takeaway

Steal the policy split:

- `AUTO`
- `ASK`
- `BLOCK`

But implement it in the review/approval engine, not just in prompt text.

## 7. State persistence across sessions

This is where GStack is materially ahead of Superpowers.

### Home-scoped state under `~/.gstack`

| Path | Purpose |
|---|---|
| `~/.gstack/config.yaml` | operator prefs like `proactive`, `telemetry`, `skip_eng_review`, `repo_mode` |
| `~/.gstack/projects/<slug>/*-design-*.md` | design docs from `/office-hours` |
| `~/.gstack/projects/<slug>/*-eng-review-test-plan-*.md` | test plans from plan review |
| `~/.gstack/projects/<slug>/*-test-outcome-*.md` | QA outcome artifacts |
| `~/.gstack/projects/<slug>/<branch>-reviews.jsonl` | review ledger and shipping overrides |
| `~/.gstack/sessions/<PPID>` | active session tracking |
| `~/.gstack/analytics/*.jsonl` | skill usage, spec-review metrics, field reports, eureka logs |
| `~/.gstack/contributor-logs/*.md` | contributor mode field reports |
| `~/.gstack/.telemetry-prompted` / `.completeness-intro-seen` | once-per-user onboarding flags |

### Repo-local state

| Path | Purpose |
|---|---|
| `.gstack/browse.json` | browser daemon locator + auth token |
| `.gstack/*.log` | browse console/network/dialog logs |
| `.gstack/qa-reports/...` | QA reports and screenshots |
| `.context/retros/*.json` | retro history snapshots |
| `.context/codex-session-id` | `/codex` consult-mode continuity |

This is the strongest thing GStack has that Superpowers does not.

It is still an ad hoc filesystem store, not a proper DB-backed workflow state model, but the concept is good.

## 8. What runtimes GStack supports

### First-class packaging

GStack’s own generator and `setup` script clearly support:

- Claude Code
- Codex-compatible hosts through `.agents/skills/`

### Claimed or tested compatible hosts

From `README.md`, `setup`, and tests:

- Claude Code
- Codex CLI
- Gemini CLI
- Cursor

Nuance:

- Claude gets the source `SKILL.md` tree
- Codex gets generated `.agents/skills/gstack-*`
- Gemini and Cursor appear to piggyback on the same `.agents/skills` packaging model
- Codex and Gemini both have dedicated E2E tests

### Important limitation

This is **distribution support**, not runtime orchestration support.

GStack does not have:

- a capability matrix
- runtime selection per stage
- fallback planning based on runtime features
- an adapter abstraction like Cortex’s `RuntimeSurface`

It ships the same logical skill system in host-shaped wrappers.

For Cortex specifically, that means GStack aligns directly with:

- Claude Code
- Codex

It only aligns indirectly with:

- Gemini / Cursor via the `.agents/skills` packaging model

And it does **not** align at all with:

- OpenClaw

So even before workflow-engine concerns, a Cortex-native adoption would require a new OpenClaw-facing translation layer.

## 9. How Reflect feeds back into future sprints

This is the weakest stage in the pipeline.

### What `/retro` actually does well

- computes commit / test / streak / session metrics
- writes a JSON snapshot to `.context/retros/`
- compares against the previous retro snapshot
- produces a strong narrative summary

### What it does not do

- it does not automatically alter future workflow policy
- it does not feed structured lessons back into planning artifacts
- it does not update routing rules
- it does not create a machine-readable “lesson learned” store used by later stages

There are a few weak feedback paths:

- the next `/retro` run reads prior retro snapshots
- Greptile history is persisted and later used to skip known false positives
- some planning skills perform a “Retrospective Check,” but that is mostly git-history based, not a read of `.context/retros/`

### Bottom line

Reflect in GStack is mostly **reporting**, not **control-loop learning**.

For Cortex, Reflect should become:

- structured postmortem artifacts
- reusable failure patterns
- workflow policy updates
- future trigger/routing hints
- memory writes into Cortex proper

## 10. Comparison to Superpowers

This extends the findings in `docs/research/superpowers-audit.md`.

### Which one is better designed?

The answer depends on the layer.

| Concern | Better designed | Why |
|---|---|---|
| Skill discipline | Superpowers | Smaller, cleaner, stricter, better execution grammar |
| Explicit Build-stage process | Superpowers | Real `plan -> worktree -> subagent execution -> review` flow |
| Cross-session workflow state | GStack | Better artifact store, review ledger, readiness state |
| Operational breadth | GStack | QA, browser, ship, deploy, canary, retro |
| Host packaging | Slight edge: Superpowers | Better marketplace/distribution story |
| Reusable workflow primitives for Cortex | Slight edge: GStack | More of the ideas we actually need for a control plane |

My practical read:

- **Superpowers is better designed as a skill system**
- **GStack is better designed as a workflow shell**

For Cortex, that means:

- steal Build discipline from Superpowers
- steal stateful stage plumbing from GStack

## 11. What primitives we should steal for Cortex

### Steal directly

- **Stage taxonomy**: Think / Plan / Review / Test / Ship / Reflect is a good top-level operator model
- **Artifact store concept**: design docs, test plans, test outcomes, review ledgers, overrides
- **Review readiness dashboard**: a cheap but effective readiness abstraction
- **`AUTO-FIX` vs `ASK` split**: very useful for human trust
- **Shared completion status vocabulary**: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT`
- **Diff-scope classification**: useful for deciding required reviews
- **Persistent browser sidecar**: if Cortex wants serious QA workflows, this is the bar

### Steal with adaptation

- **`benefits-from` / prerequisite artifacts**
  - good idea, but should become typed workflow preconditions
- **Review logs**
  - good idea, but should live in Cortex workflow state, not JSONL in dotfiles
- **Host-specific generated prompt packs**
  - useful, but they should sit behind runtime adapters and capability maps

## 12. What GStack is missing for Cortex Agent Workflows

To turn this into a GUI-driven workflow builder for Cortex, we would need to add all of the following:

1. **A real workflow graph**
   - typed nodes, typed edges, stage preconditions, stage outputs
2. **A durable run model**
   - workflow run, stage run, attempt, approval, artifact, retry state
3. **Runtime capability routing**
   - choose OpenClaw vs Codex vs Claude Code per stage
4. **A first-class Build executor**
   - task decomposition, worktree assignment, worker ownership, checkpoints
5. **UI-native approvals**
   - approval cards, branch-aware overrides, one-click accept/reject/retry
6. **Event/webhook triggers**
   - Sentry, GitHub, cron, manual launch, inbox rules
7. **External integration surfaces**
   - issue systems, PRs, logs, Sentry, deployments
8. **Structured Reflect outputs**
   - lessons learned, known failure modes, trigger feedback, memory writes
9. **Multi-tenant / multi-repo governance**
   - policies, permissions, budgets, ownership, auditability
10. **Background execution**
   - workflows that survive UI disconnects and can be resumed later

Without those, GStack remains a good CLI playbook, not a workflow product foundation.

## 13. Reference use case: Sentry crash webhook -> triage -> PR or close issue

### What GStack contributes

GStack is strong from the moment the repo context and incident context already exist:

- `/investigate` for root-cause work
- `/plan-eng-review` when the fix needs real design scrutiny
- `/review` for fix-first review
- `/qa` for browser-visible regressions
- `/ship` for PR creation
- `/land-and-deploy` and `/canary` for post-merge verification

### What it does not contribute

It does not natively provide:

- webhook ingestion
- incident queueing
- dedupe / fingerprinting
- issue ownership
- policy for “close issue vs open PR vs escalate”
- background execution state
- UI approvals

### Cortex-native shape for this workflow

The Cortex workflow should look more like:

1. **Trigger**
   - Sentry webhook creates a workflow run
2. **Triage**
   - pull stack trace, release, blame range, logs, prior incidents
3. **Decision**
   - classify: duplicate / config / code defect / flaky / needs human
4. **Plan**
   - propose fix path and blast radius
5. **Build**
   - create branch/worktree, patch, add regression coverage
6. **Review**
   - automated review passes + human gate if needed
7. **Test**
   - relevant runtime tests, browser QA if user-visible
8. **Outcome**
   - create PR, close issue, or escalate
9. **Human**
   - one-click merge / reject / request changes
10. **Reflect**
   - persist incident pattern into Cortex memory and workflow heuristics

That is conceptually GStack-shaped, but architecturally it is a Cortex workflow engine, not GStack.

## Recommendation

**Recommendation: adapt GStack’s model, but design our own system.**

More precisely:

- **Do not** adopt GStack’s repo, dotfile store, or prompt-only workflow enforcement as the foundation for Cortex Agent Workflows.
- **Do** use GStack as a reference model for:
  - stage naming
  - artifact contracts
  - review readiness
  - auto-fix vs ask policy
  - browser-backed QA
- **Do** combine that with Superpowers’ stronger Build-stage execution discipline.

If I had to reduce this to one sentence:

> GStack gives us the right workflow shape and the right persistence instincts, but Cortex still needs to build the actual control plane.
