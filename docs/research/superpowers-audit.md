# Superpowers + GStack Audit

Issue: #248  
Audit date: 2026-03-22

Audited snapshots:
- `obra/superpowers` @ `8ea39819eed74fe2a0338e71789f06b30e953041`
- `garrytan/gstack` @ `7ff0f84b1e37a792ef6127a91f8ba3f83e1e3913`

## Bottom line

Neither project is a true workflow engine.

Both are skill-first operating systems built out of Markdown instructions, skill metadata, shell commands, and a few runtime helpers. That matters because the strongest ideas here are not "copy the repo" ideas. They are:

- take **Superpowers' stage discipline and hard gates**
- take **GStack's artifact store, readiness logs, and auto-fix vs ask split**
- do **not** copy either one wholesale into Cortex IDE

Cortex IDE should build a real workflow control plane above runtime adapters for OpenClaw, Codex, and Claude Code, then import selected patterns from these systems as workflow templates and review policies.

## Quick comparison

| Axis | Superpowers | GStack |
|---|---|---|
| Core shape | Narrow, strict software-delivery pipeline | Broad software factory with many specialist skills |
| Stage model | Sequential skill chain with local loops | Sequential sprint model with artifact-driven coordination |
| Workflow state | Mostly implicit in docs, plan files, worktrees, and agent behavior | Explicit local artifact store, review logs, telemetry, browser daemon state |
| Approval style | Human sign-off gates in skill text | `AUTO-FIX` vs `ASK`, review dashboards, persisted overrides |
| Retry model | Stage-local loops, usually max 3 iterations | Shared completion protocol plus stage-specific retries |
| Marketplace / registry | Real plugin marketplace story plus filesystem discovery | Repo-as-registry, generated host-specific skill bundles |
| Best contribution | Strong process discipline | Strong cross-skill memory and operational plumbing |
| Main weakness | Too little durable state | More machinery, but still not a real orchestrator |

## 1. How do they define workflow stages?

### Superpowers

Superpowers defines stages as a **sequential skill chain**, not as a compiled state machine.

The canonical flow is:

`brainstorming -> using-git-worktrees -> writing-plans -> subagent-driven-development or executing-plans -> test-driven-development -> requesting-code-review -> finishing-a-development-branch`

This is encoded in:

- `README.md`
- `skills/brainstorming/SKILL.md`
- `skills/writing-plans/SKILL.md`
- `skills/subagent-driven-development/SKILL.md`

Important detail: the stages are mostly enforced by **instructional hard gates** inside the skills, not by a shared runtime state object. There are local loops inside stages, such as:

- design revision loop
- spec review loop
- plan review loop
- per-task review loops in subagent-driven development

So the right label is:

- **sequential**
- **instruction-driven**
- **looping inside stages**
- **not event-driven**
- **not a formal state machine**

### GStack

GStack defines stages as a **named sprint lifecycle**:

`Think -> Plan -> Build -> Review -> Test -> Ship -> Reflect`

This appears in:

- `README.md`
- `docs/skills.md`
- `SKILL.md`

The mapping is looser than Superpowers:

- Think: `/office-hours`
- Plan: `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/autoplan`
- Build: mostly implicit normal coding between plan and review
- Review: `/review`, `/design-review`, `/codex`
- Test: `/qa`, `/qa-only`
- Ship: `/ship`, `/land-and-deploy`, `/canary`, `/document-release`
- Reflect: `/retro`

GStack is still **not a formal central state machine**, but it is closer to one because downstream skills read and write shared artifacts:

- design docs
- test-plan artifacts
- review logs
- review readiness dashboard state
- telemetry and session files

So the right label is:

- **sequential stage model**
- **artifact-driven coordination**
- **semi-formal readiness state**
- **not a central orchestrator**

### Cortex takeaway

Steal the named stages from GStack and the hard gates from Superpowers, but encode them as a real machine-readable workflow graph.

## 2. How do skills detect which phase to activate?

### Superpowers

Phase activation is mostly **contextual and descriptive**.

The key mechanisms are:

- YAML frontmatter `description` fields in each `SKILL.md`
- the always-on `using-superpowers` skill
- platform-native skill discovery
- explicit skill invocation when the agent decides a skill applies

The Codex docs explicitly say the `description` field is how Codex decides whether to activate a skill. `using-superpowers` then adds a much stricter meta-rule: if there is even a small chance a skill applies, invoke it before doing anything else.

This means Superpowers phase detection is driven by:

- natural-language intent
- skill descriptions
- meta-policy that forces skill checks early

It is **not** driven by durable workflow markers.

### GStack

GStack uses a richer mix:

- frontmatter descriptions in each skill
- top-level `SKILL.md` that maps user situation to recommended skill
- proactive suggestions, controlled by `gstack-config`
- `benefits-from` metadata on some skills
- artifact existence checks inside downstream skills

Examples:

- `/office-hours` is suggested when the user is ideating
- `/plan-eng-review` is suggested when the user has a plan and is about to code
- `plan-eng-review` checks whether a design doc exists in `~/.gstack/projects/...`
- `ship` reads review logs to determine readiness
- routing is exercised in `test/skill-routing-e2e.test.ts`

So GStack phase detection is:

- **conversation-aware**
- **artifact-aware**
- **readiness-log-aware**
- still mostly prompt-native rather than engine-native

### Cortex takeaway

Do not rely on prompt text alone. Phase activation in Cortex should combine:

- user intent
- workflow template preconditions
- artifact presence
- prior stage outcomes
- runtime capability availability

## 3. How do they handle approval gates between stages?

### Superpowers

Superpowers uses **strong human sign-off gates**, but they are mostly conversational rather than system-enforced.

Examples:

- `brainstorming` forbids implementation before the design is presented and approved
- the written spec must be user-reviewed before moving to plan writing
- `writing-plans` asks the user to choose execution mode
- `finishing-a-development-branch` presents four explicit end-state options
- review findings block forward progress until fixed

This is good process discipline, but there is no shared approval ledger. The agent is expected to remember and respect the gate.

### GStack

GStack has a more operational gate model.

It still uses `AskUserQuestion`, but it adds policy structure:

- `AUTO-FIX` vs `ASK`
- required vs optional review tiers
- persisted review results
- persisted review overrides
- non-interactive workflows with enumerated stop conditions

Examples:

- `/review` auto-fixes mechanical issues and batches judgment calls into `ASK`
- `/ship` runs straight through unless it hits specific gate conditions
- Eng Review is the only required review by default
- ship-review overrides are persisted in `~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl`

This is materially stronger than Superpowers because it separates:

- things the agent may do alone
- things that require human judgment
- things that block shipping

### Cortex takeaway

Use GStack's policy split:

- `AUTO`
- `ASK`
- `BLOCK`

But persist every approval, rejection, and override as first-class workflow state.

## 4. How do they handle failure/retry within a stage?

### Superpowers

Failure and retry are stage-local.

Patterns observed:

- spec review loop: fix and re-dispatch until approved, max 3 iterations
- plan review loop: fix and re-dispatch until approved, max 3 iterations
- subagent-driven development: handles `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`
- failed review means fix and re-review, never proceed
- TDD loop forces redo when the red/green sequence is violated

This is a solid retry model for coding tasks, but it is mostly embedded in prompt instructions.

### GStack

GStack standardizes failure handling more aggressively across skills.

Common elements:

- completion protocol: `DONE`, `DONE_WITH_CONCERNS`, `BLOCKED`, `NEEDS_CONTEXT`
- explicit escalation format
- stop after 3 failed attempts
- stage-specific retry loops for plan review, QA fix loops, review fix loops, browser recovery

Important runtime detail: the `/browse` daemon does not try to self-heal in place. If Chromium dies, the server exits and the next CLI call restarts the stack. That is a good operational choice.

### Cortex takeaway

Keep GStack's shared status vocabulary and Superpowers' review-loop rigor. Add per-stage retry budgets and machine-readable recovery actions.

## 5. How do they persist workflow state across sessions?

### Superpowers

Superpowers persists state mostly through **repo artifacts and git**, not through a dedicated workflow store.

Persistence mechanisms:

- design docs in `docs/superpowers/specs/...`
- plan docs in `docs/superpowers/plans/...`
- git worktrees and branches
- commits
- platform-native session history

What is missing:

- no workflow run record
- no persistent approval log
- no branch-scoped review ledger
- no artifact index outside whatever the user or agent reconstructs manually

If a session dies, the recovery story is basically:

- reopen the repo
- read the spec
- read the plan
- inspect git
- continue manually

### GStack

GStack has a real local artifact layer under `~/.gstack/`.

Important persisted state includes:

- `~/.gstack/projects/$SLUG/*-design-*.md`
- `~/.gstack/projects/$SLUG/*-test-plan-*.md`
- `~/.gstack/projects/$SLUG/*-test-outcome-*.md`
- `~/.gstack/projects/$SLUG/$BRANCH-reviews.jsonl`
- `~/.gstack/sessions/`
- `~/.gstack/analytics/*.jsonl`
- `.gstack/browse.json`
- `.gstack/*.log`

This gives GStack:

- design lineage
- review readiness state
- branch-specific override history
- cross-session skill analytics
- persistent browser session lookup

This is the single biggest structural difference between the two projects.

### Cortex takeaway

GStack's artifact-store idea is worth copying. Cortex should have durable workflow runs, stage runs, approvals, artifacts, and overrides. Superpowers' repo-local docs are not enough.

## 6. What is their skill marketplace / registry design?

### Superpowers

Superpowers has the stronger **distribution story**.

It ships through:

- official Claude plugin marketplace
- custom Claude marketplace metadata in `.claude-plugin/marketplace.json`
- Cursor plugin metadata
- Gemini extension metadata
- Codex/OpenCode installation via clone + symlink into native skill directories

At runtime, the registry model is still basically **filesystem discovery of skill folders**, but the packaging story is real and multi-host.

So Superpowers is:

- **marketplace-backed at distribution time**
- **filesystem-discovered at runtime**

### GStack

GStack is different:

- no separate marketplace
- repo is the distribution unit
- `setup` builds binaries, wires symlinks, and installs host-specific skill layouts
- generated Codex-format skills live in `.agents/skills/gstack-*`
- vendoring into a repo is a first-class install path

GStack's "registry" is:

- **the git repo itself**
- plus generated host-specific wrappers
- plus a setup script that links everything into the agent's discovery directories

This is simpler, but it is not a marketplace.

### Cortex takeaway

For Cortex IDE, treat "workflow registry" and "distribution channel" as separate concerns. Superpowers' marketplace packaging is useful. GStack's generated per-host bundles are also useful.

## 7. Compare Superpowers vs GStack: where do they agree and differ?

### Where they agree

- Both are skill-first systems built from Markdown instructions.
- Both rely heavily on frontmatter descriptions and natural-language routing.
- Both assume the model can and should follow a disciplined multi-stage delivery flow.
- Both are human-in-the-loop, not fire-and-forget autonomous orchestration engines.
- Both use subagents or secondary review passes for quality control.
- Both persist important context in files more than in databases.

### Where they differ

- Superpowers is narrower and stricter. It is optimized for design -> plan -> TDD -> review execution discipline.
- GStack is wider and more operational. It spans ideation, planning, code review, QA, shipping, deploy verification, and retros.
- Superpowers keeps state implicit. GStack makes state visible through artifacts, dashboards, and logs.
- Superpowers' build stage is explicit and disciplined. GStack's "Build" stage is mostly implied between plan and review.
- Superpowers has a stronger marketplace story. GStack has a stronger local runtime and artifact story.
- GStack is much more persona-heavy. The voice and operating doctrine are part of the product.

### Practical read

If I had to summarize them in one line each:

- Superpowers: **a strict coding workflow**
- GStack: **a local software-factory operating system**

## 8. What patterns translate well to a desktop IDE with three agent runtimes?

These patterns translate well:

### From Superpowers

- hard gates before coding
- explicit spec -> plan -> execution separation
- mandatory review loops
- worktree isolation before implementation
- subagent status taxonomy for execution workers

### From GStack

- project-scoped artifact store
- review readiness dashboard
- `AUTO-FIX` vs `ASK` routing
- cross-session logs and overrides
- prerequisite artifact checks before downstream stages
- generated host-specific skill bundles

### What does not translate directly

- prompt-only enforcement as the primary control mechanism
- hardcoded shell paths like `~/.gstack` or `~/.claude/skills`
- slash-command UX as the workflow model
- repo-specific shell snippets as the source of truth

### Cortex-specific implication

Because Cortex has three runtimes, the workflow system must be **runtime-agnostic first**. A stage should declare required capabilities, not a specific agent brand.

Examples:

- `can_plan`
- `can_edit_code`
- `can_run_browser_tests`
- `can_review_diff`
- `can_open_pr`

Then OpenClaw, Codex, and Claude Code adapters satisfy those capabilities differently.

## 9. What can we steal wholesale vs what needs adaptation?

### Steal wholesale

From Superpowers:

- hard implementation gates
- spec / plan / execution separation
- review-before-progress rule
- worktree isolation pattern

From GStack:

- artifact store concept
- readiness dashboard concept
- auto-fix vs ask policy split
- persisted review logs and overrides
- completion status protocol

### Needs adaptation

From Superpowers:

- replace prompt-only discipline with durable workflow state
- convert repo-local doc paths into Cortex artifact abstractions
- remove platform-specific assumptions about skill loading

From GStack:

- strip persona-specific voice from core workflow logic
- move global state from ad hoc dotfiles into a managed Cortex store
- replace shell-heavy slash-command flows with desktop UI controls and API-backed runs
- formalize "Build" as a first-class stage instead of an implied gap between plan and review

### Do not copy

- Superpowers' assumption that the workflow is mainly "agent follows instructions inside one coding session"
- GStack's assumption that local files in `~/.gstack` are enough to serve as the durable control plane

## 10. Reference example: "Sentry detects crash -> agent triages -> creates PR or closes issue"

### How Superpowers would implement it

This is possible, but it needs outside help.

Likely flow:

1. External automation receives the Sentry event and opens a branch or issue with logs, traces, and code pointers.
2. Agent uses `systematic-debugging` to trace the fault.
3. If the fix is non-trivial, agent writes a spec or execution plan.
4. Agent runs `subagent-driven-development` with TDD and review loops.
5. Agent uses `requesting-code-review`.
6. Agent uses `finishing-a-development-branch` and selects "create PR" if code changed.
7. If the incident is invalid / duplicate / config-only, agent closes the issue instead of opening a PR.
8. Human merges.

What works well:

- disciplined debugging
- strong fix-and-review loop
- safe code-change workflow

What is missing:

- no native event trigger model
- no durable incident state model
- no operational concept of alert inbox, retries, SLA, ownership, or post-merge verification

### How GStack would implement it

This fits better, but still needs an outer trigger.

Likely flow:

1. External automation receives the Sentry event and opens a workspace or issue.
2. Incident artifact is written to `~/.gstack/projects/$SLUG/...`.
3. Agent runs `/investigate` with logs, traces, and blame context.
4. If fix requires architecture changes, agent runs `/plan-eng-review`.
5. Agent implements fix.
6. Agent runs `/review` and auto-fixes mechanical findings.
7. Agent runs `/qa` if user-visible behavior is affected, or `/qa-only` if report-only is enough.
8. Agent runs `/ship` to create PR.
9. After merge, `/land-and-deploy` and `/canary` can validate production.
10. `/retro` later captures the incident pattern.

What works well:

- much better post-fix operational flow
- explicit review and ship readiness
- better artifact continuity across sessions

What is missing:

- still no first-class event-driven workflow engine
- still assumes conversational entry more than background trigger execution
- still needs a policy layer deciding when to auto-close vs auto-PR vs escalate

### Cortex recommendation for this example

The Cortex-native workflow should be:

`Trigger -> Triage -> Reproduce / Investigate -> Decision (close or fix) -> Plan -> Build -> Review -> Test -> PR -> Merge -> Canary -> Reflect`

That is a better fit for a desktop IDE than either source project as-is.

## Recommendations

## Recommended workflow primitives for Cortex IDE

The minimum useful primitive set is:

- `WorkflowTemplate`
- `Trigger`
- `Run`
- `Stage`
- `Artifact`
- `Decision`
- `Approval`
- `ReviewRecord`
- `RetryPolicy`
- `EscalationPolicy`
- `RuntimeAssignment`
- `CapabilityRequirement`
- `Evidence`
- `Outcome`

Important design choice: make **Build** explicit. GStack's lifecycle names it, but its implementation mostly leaves it implicit. Cortex should not.

Suggested stage statuses:

- `pending`
- `ready`
- `running`
- `waiting_for_human`
- `blocked`
- `needs_context`
- `done`
- `done_with_concerns`
- `skipped`

Suggested approval policies:

- `auto`
- `ask`
- `required`
- `forbidden`

Suggested retry metadata:

- retry budget
- backoff / cooldown
- retry reason
- last failure reason
- escalation target

## Skills worth importing or adapting

### Highest-value imports

From Superpowers:

- `systematic-debugging`
- `verification-before-completion`
- `writing-plans`
- `using-git-worktrees`

From GStack:

- `/plan-eng-review`
- `/review`
- `/qa-only`
- `/qa`
- `/ship`
- `/retro`
- `/codex`

### Import with adaptation, not verbatim

- Superpowers `brainstorming`
  - good structure, but tone and assumptions should be normalized for Cortex
- GStack `/office-hours`
  - strong for ideation, but too YC-specific to be the default Cortex voice
- GStack `/plan-ceo-review`
  - useful as an optional "strategy review" workflow, not as a universal prerequisite

## Architecture recommendation for Cortex IDE

Build a hybrid:

### 1. Machine-readable workflow layer

Each workflow should be stored as structured data:

- stages
- edges
- required artifacts
- approval policy
- retry policy
- runtime capability requirements
- default prompts / instructions

Markdown can still be used for agent-facing instructions, but it should not be the only source of truth.

### 2. Runtime adapter layer

Define canonical actions such as:

- inspect repo
- read artifact
- run tests
- review diff
- open browser
- create branch
- create PR
- close issue

Then map those actions to OpenClaw, Codex, and Claude Code separately.

### 3. Durable local state

Persist workflow state inside Cortex-managed storage, not only in prompts.

Good options:

- repo-local `.cortex/workflows/`
- SQLite database for richer indexing
- optional sync/export layer later

Store:

- run timeline
- stage outcomes
- approvals and overrides
- artifact pointers
- runtime execution history
- retry / escalation history

### 4. UI surfaces

The desktop IDE should expose:

- run timeline
- artifact pane
- approval queue
- review readiness view
- failure / retry inspector
- runtime assignment panel

### 5. Import strategy

Treat Superpowers and GStack as **workflow packs**, not as foundations.

Practical path:

1. Implement the Cortex workflow primitives first.
2. Import one narrow coding workflow inspired by Superpowers.
3. Import one review/QA/ship workflow inspired by GStack.
4. Add event-driven workflows like Sentry only after the control plane exists.

## Recommendation summary

If Cortex copies Superpowers, it will get discipline but not enough state.

If Cortex copies GStack, it will get artifacts and operational coverage but inherit a lot of prompt-native complexity and persona baggage.

The right move is:

- **Superpowers discipline**
- **GStack memory and gate model**
- **Cortex-native workflow engine above runtime adapters**

## Key source files reviewed

### Superpowers

- `README.md`
- `docs/README.codex.md`
- `.codex/INSTALL.md`
- `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json`
- `hooks/session-start`
- `skills/using-superpowers/SKILL.md`
- `skills/brainstorming/SKILL.md`
- `skills/writing-plans/SKILL.md`
- `skills/subagent-driven-development/SKILL.md`
- `skills/test-driven-development/SKILL.md`
- `skills/requesting-code-review/SKILL.md`
- `skills/finishing-a-development-branch/SKILL.md`
- `tests/skill-triggering/run-test.sh`

### GStack

- `README.md`
- `ARCHITECTURE.md`
- `CLAUDE.md`
- `SKILL.md`
- `docs/skills.md`
- `setup`
- `office-hours/SKILL.md`
- `plan-ceo-review/SKILL.md`
- `plan-eng-review/SKILL.md`
- `review/SKILL.md`
- `qa/SKILL.md`
- `ship/SKILL.md`
- `retro/SKILL.md`
- `test/skill-routing-e2e.test.ts`
