# o8 Platform Docs Audit Checklist

## Purpose

Use this checklist when Mister is tasked with writing or refreshing professional o8 platform documentation.

The goal is not to rewrite the existing docs from memory. The goal is to extract the current truth of o8 from the repo, running product, existing docs, and recent development history, then turn that evidence into docs that stay accurate as the platform changes.

## Non-negotiables

- Treat o8 as a live product. For this audit, make documentation-only changes unless Q explicitly approves product code edits.
- Do not trust any single existing doc as canonical. Reconcile docs against current code, route maps, UI behavior, package scripts, git history, and runtime smoke tests.
- Separate confirmed product truth from planned, speculative, historical, or deprecated material.
- Every important claim in professional docs should trace back to evidence: file path, route, component, API, CLI command, git commit, screenshot, or live smoke result.
- Do not preserve internal scratch language in public docs. Convert it into clear operator-facing or developer-facing language.
- Keep the terms aligned: o8 is the product/control plane; Cortex is the memory layer; packets, lanes, missions, reviews, approvals, tasks, projects, and repos each need a precise definition.

## Working Rule

For each candidate doc claim, fill this evidence shape before writing final docs:

```md
Claim:
Audience: user | operator | developer | investor | internal
Evidence:
Status: verified | partially verified | planned | stale | deprecated | unknown
Docs impacted:
Open questions:
```

If the status is not `verified`, label it clearly in the docs or leave it out of public-facing material.

## Phase 0 - Repo Safety And Baseline

- [ ] Confirm the repo path and branch.
  - Command: `pwd`
  - Command: `git branch --show-current`
  - Command: `git remote -v`
- [ ] Capture the dirty worktree before touching docs.
  - Command: `git status --short`
  - Rule: do not revert, overwrite, or normalize changes you did not make.
- [ ] Create or stay on the appropriate docs branch if Q wants a PR.
  - Command: `git switch -c docs/o8-platform-audit` if a branch is needed.
- [ ] Confirm package scripts and available validation gates.
  - Command: `node -e "const p=require('./package.json'); console.log(p.scripts)"`
- [ ] Record date, repo SHA, and audit scope at the top of the eventual audit output.
  - Command: `git rev-parse --short HEAD`
  - Command: `date`

## Phase 1 - Existing Docs Inventory

- [ ] List every existing Markdown doc and classify it.
  - Command: `find . -maxdepth 3 -type f -name "*.md" | sort`
  - Categories: canonical, product brief, architecture, workflow, API/reference, historical, scratch, stale, deprecated.
- [ ] Read and classify the current core docs:
  - [ ] `README.md`
  - [ ] `docs/o8-product-brief.md`
  - [ ] `docs/how-o8-works.md`
  - [ ] `docs/system-architecture.md`
  - [ ] `docs/vocabulary.md`
  - [ ] `docs/canonical-workflow.md`
  - [ ] `docs/runtime-adapter-contract.md`
  - [ ] `docs/runtime-adapter-v2.md`
  - [ ] `docs/openclaw-integration.md`
  - [ ] `docs/mobile-strategy.md`
  - [ ] `docs/mobile-control-service-contract.md`
  - [ ] `docs/agent-task-pool-control-plane.md`
  - [ ] `docs/roadmap.md`
  - [ ] `docs/issue-map.md`
  - [ ] `docs/monetization-issues.md`
- [ ] Identify docs that contain old names or old architecture.
  - Search terms: `Cortex IDE`, `Mission Control`, `thoughts`, `workspace side panel`, `claude-code dropped`, `historical`, `deprecated`, `planned`, `not started`.
  - Command: `rg -n "Cortex IDE|Mission Control|deprecated|historical|not started|planned|TODO|FIXME" docs README.md o8.md`
- [ ] Decide which docs become source material and which become archived/historical references.
- [ ] Build a docs gap list: what a new user, operator, developer, and investor still cannot understand after reading current docs.

## Phase 2 - Product Truth Extraction

- [ ] Write the current one-sentence product definition from evidence, not memory.
  - Candidate to verify: o8 is a governance/control plane for autonomous engineering teams with desktop, mobile, MCP, CLI/API, runtime adapters, worktrees, review, approvals, audit, and memory.
- [ ] Extract the core product jobs:
  - [ ] Connect or select repos/projects.
  - [ ] Brief the operator on repo/project state.
  - [ ] Turn goals/issues into tasks, packets, or missions.
  - [ ] Dispatch agents into isolated lanes/worktrees.
  - [ ] Monitor progress, events, terminals, costs, context, and blockers.
  - [ ] Review diffs and findings.
  - [ ] Approve, reject, retry, reset, merge, or close.
  - [ ] Preserve memory and project context across sessions.
  - [ ] Expose mobile approval/steering where supported.
- [ ] Separate v1 wedge from long-term platform:
  - [ ] Current wedge: solo operator, local desktop control plane, CLI runtimes, worktrees, approval/governance.
  - [ ] Future platform: cloud sync, team governance, managed orchestrator runtime, org templates, richer mobile.
- [ ] Identify the actual moats stated in current docs and verify each against implementation:
  - [ ] Governance layer.
  - [ ] Organizational memory/session graph.
  - [ ] Mobile operator surface.
  - [ ] Provider/runtime neutrality as infrastructure.

## Phase 3 - Surface Map

- [ ] Inventory app routes.
  - Command: `find src/app -type f \( -name "page.tsx" -o -name "route.ts" -o -name "layout.tsx" \) | sort`
- [ ] Classify each route as public surface, desktop app surface, mobile surface, preview/mock, API, or internal.
- [ ] Map the main desktop surfaces:
  - [ ] Dashboard shell.
  - [ ] Repo/project focus.
  - [ ] Agent panel.
  - [ ] O8 panel: Activity, Pulse, PRs, Specs, Inbox, Browser, Changes.
  - [ ] Workspace terminal.
  - [ ] Review/PR panes.
  - [ ] Approval queue and audit log.
  - [ ] Context graph.
  - [ ] Task board / task pool.
  - [ ] Repo registry.
- [ ] Map the mobile surfaces:
  - [ ] Mobile home / workspaces.
  - [ ] Mobile assistant chat.
  - [ ] Mobile approvals.
  - [ ] Repo picker.
  - [ ] Tool cards.
  - [ ] Offline states.
- [ ] Map the API and headless surfaces:
  - [ ] Next API routes under `src/app/api`.
  - [ ] WebSocket server `src/ws-server.ts`.
  - [ ] CLI under `cli/src`.
  - [ ] MCP tools under `src/lib/mcp`.
  - [ ] Tauri shell under `src-tauri`.
- [ ] For each surface, capture:
  - User job.
  - Route/component/file.
  - Data source.
  - Actions available.
  - Current implementation status.
  - Screenshot needed for docs.

## Phase 4 - Concept And Vocabulary Reconciliation

- [ ] Start from `docs/vocabulary.md`, then verify every term against code.
- [ ] Define and verify these nouns:
  - [ ] Product.
  - [ ] Project.
  - [ ] Repo.
  - [ ] Runtime.
  - [ ] Agent.
  - [ ] Session.
  - [ ] Task.
  - [ ] Packet.
  - [ ] Lane.
  - [ ] Mission.
  - [ ] Review.
  - [ ] Approval.
  - [ ] Worktree.
  - [ ] Branch.
  - [ ] Context graph.
  - [ ] Memory.
  - [ ] Operator.
- [ ] Find all places where UI labels intentionally diverge from internal names.
  - Example to verify: visible `Packets` tab may still use internal id `agents`.
- [ ] List retired terms that must not be reintroduced.
  - Examples to verify: Mission Control, old tile kinds, old thoughts/orchestrator-history surfaces.
- [ ] Create a public glossary and an internal implementation vocabulary if one glossary cannot serve both audiences cleanly.

## Phase 5 - Architecture And Data Flow

- [ ] Build a current architecture map from code:
  - [ ] Client surfaces: desktop, mobile, previews.
  - [ ] Control plane: routes, stores, orchestrator, task pool, lane bus, supervisor.
  - [ ] Runtime adapters: Codex, Claude Code, OpenClaw, Gemini, opencode, future entries.
  - [ ] Delivery layer: Git, GitHub, branches, worktrees, PRs, diffs.
  - [ ] Memory layer: Cortex, recall, project context, compaction/state if present.
  - [ ] Storage: SQLite, local JSON/state files, Tauri store, generated artifacts.
  - [ ] Transport: WebSocket, Next API, MCP, CLI, Tauri commands.
- [ ] Inventory major source directories.
  - Command: `find src/lib -maxdepth 2 -type d | sort`
  - Command: `find src/components/desktop -maxdepth 2 -type d | sort`
  - Command: `find src/app/api -maxdepth 3 -type f -name "route.ts" | sort`
- [ ] Extract DB/schema facts.
  - Search: `rg -n "CREATE TABLE|sqlite|drizzle|migration|schema|ALTER TABLE" src scripts`
- [ ] Extract API contracts.
  - Search: `rg -n "export async function (GET|POST|PUT|PATCH|DELETE)" src/app/api`
  - For each route: method, input shape, output shape, auth/permissions, error modes, data source.
- [ ] Extract event and WebSocket contracts.
  - Search: `rg -n "WebSocket|ws|event|broadcast|subscribe|publish" src`
- [ ] Extract Tauri and desktop shell contracts.
  - Files: `src-tauri/tauri.conf.json`, `src-tauri/src/*`, `src-tauri/capabilities/*`.
- [ ] Produce one system diagram that reflects current code, not just desired architecture.

## Phase 6 - Runtime And Agent Control Audit

- [ ] Inventory runtime adapters and routing code.
  - Search: `rg -n "runtime|Runtime|codex|claude|openclaw|gemini|opencode|workerIntent|requestedProvider|selectedRuntime" src/lib cli/src`
- [ ] Verify which runtimes are real production launch targets today.
- [ ] Verify which runtime hints are preserved as metadata but not yet executable.
- [ ] For each runtime, document:
  - Launch mechanism.
  - Attach/resume mechanism.
  - Transcript source.
  - Diff/artifact source.
  - Stop/kill/interrupt support.
  - Worktree support.
  - Approval or policy integration.
  - Known limitations.
- [ ] Confirm the three-runtime rule still applies to every relevant feature:
  - [ ] OpenClaw.
  - [ ] Codex.
  - [ ] Claude Code CLI.
- [ ] If a runtime is intentionally removed or paused, document why and what remains in code.

## Phase 7 - Task, Packet, Lane, Mission, And Review Loop

- [ ] Trace the happy path from user intent to shipped code:
  - [ ] User creates or selects project/repo.
  - [ ] User or orchestrator creates task/packet/mission.
  - [ ] System resolves scope.
  - [ ] Lane/worktree opens.
  - [ ] Runtime launches.
  - [ ] Agent reports progress.
  - [ ] Supervisor detects state.
  - [ ] Review captures findings.
  - [ ] Approval gate resolves.
  - [ ] Merge/close/retry/reset happens.
- [ ] Verify each step with source files and API/MCP/CLI entry points.
- [ ] Read these areas specifically:
  - [ ] `src/lib/tasks`
  - [ ] `src/lib/lane`
  - [ ] `src/lib/orchestrator`
  - [ ] `src/lib/mcp`
  - [ ] `src/lib/approvals`
  - [ ] `src/components/desktop/o8-panel`
  - [ ] `src/components/desktop/review`
  - [ ] `src/components/desktop/pr-panel`
- [ ] Build a state-machine table for packets, lanes, tasks, reviews, approvals, and PRs.
- [ ] Identify every operator action and its side effect.
- [ ] Document reset, retry, block, report, review, approve, merge, and close behavior with exact entry points.

## Phase 8 - Projects, Repos, Workspaces, And Context

- [ ] Audit the project model.
  - Files: `src/lib/projects/store.ts`, `src/lib/projects/context.ts`, project API routes, repo registry components.
- [ ] Document:
  - What a project is.
  - How repos attach to projects.
  - Main repo vs related repos.
  - Suggested repo origins.
  - How active project context is resolved.
  - How project context becomes task/packet scope.
- [ ] Audit worktree handling.
  - Search: `rg -n "worktree|branch|baseBranch|headSha|defaultBranch" src cli docs`
  - Docs: `docs/worktree-storage-path-decision.md`.
- [ ] Verify isolation promises:
  - Agents work in worktrees.
  - Main branch is protected by process/policy.
  - Existing-branch policy behavior is documented.
- [ ] Capture file/path lock behavior and allowed/blocked path handling if implemented.

## Phase 9 - Governance, Policy, Approvals, And Audit

- [ ] Inventory policy files and approval stores.
  - Search: `rg -n "approval|policy|risk|audit|governance|approve|reject|merge" src docs cli`
- [ ] Verify the current number and names of policy rules before repeating any count from existing docs.
- [ ] Document approval sources:
  - [ ] Tool/preflight policy.
  - [ ] Diff review.
  - [ ] Merge gate.
  - [ ] Mobile approval.
  - [ ] MCP approval.
  - [ ] Human desktop action.
- [ ] Document audit trail:
  - Event source.
  - Persisted fields.
  - UI surfaces.
  - Export/debug path if any.
- [ ] Separate governance that exists today from enterprise/team governance planned later.

## Phase 10 - Memory, Context, And Cortex Layer

- [ ] Identify what Cortex means inside the o8 repo today.
  - Search: `rg -n "Cortex|cortex|memory|recall|context|compaction|provenance" src docs cli`
- [ ] Classify memory capabilities:
  - [ ] Implemented in UI/API.
  - [ ] Implemented by CLI but not surfaced.
  - [ ] Planned/speculative.
  - [ ] Deprecated/shelved.
- [ ] Document how context is built for:
  - [ ] User chat.
  - [ ] Orchestrator planning.
  - [ ] Worker packet scope.
  - [ ] Review.
  - [ ] Mobile.
  - [ ] Project/repo relationships.
- [ ] Verify whether there is a persistent session graph today, and where it lives.
- [ ] Identify automation hooks for future docs refresh: docs can update from the same context graph if the source inventory is reliable.

## Phase 11 - MCP, CLI, And External Integrations

- [ ] Inventory MCP tools from source, not docs.
  - Search: `rg -n "name: '|name: \"|McpTool|inputSchema|description:" src/lib/mcp`
- [ ] Produce a tool catalog:
  - Tool name.
  - Purpose.
  - Required inputs.
  - Side effects.
  - Output shape.
  - User-visible workflow.
  - Stability: public, internal, experimental, deprecated.
- [ ] Inventory CLI commands.
  - Files: `cli/src/index.ts`, `cli/src/commands/*`.
  - Command: `npm run build:cli` if safe.
- [ ] Inventory GitHub integration.
  - Search: `rg -n "gh |GitHub|github|issue|pull|PR|merge" src cli scripts docs`
- [ ] Inventory OpenClaw integration.
  - Docs: `docs/openclaw-integration.md`, `docs/live-openclaw-bridge.md`.
  - Search: `rg -n "openclaw|OpenClaw|gateway|sessionKey" src cli docs`.
- [ ] Inventory Tauri/updater/release integration.
  - Files: `src-tauri/tauri.conf.json`, `scripts/release.mjs`, signing scripts, deployment docs.

## Phase 12 - UX And Screenshot Evidence

- [ ] Start the app only when needed for screenshot/behavior verification.
  - Command: `npm run dev`
  - Development defaults: Next `47120`, WebSocket `47125`; packaged installs
    resolve their dynamic ports from `~/.o8/api-port` and `~/.o8/ws-port`.
- [ ] Capture desktop screenshots for:
  - [ ] First-run / repo connect.
  - [ ] Dashboard shell.
  - [ ] Project/repo focus.
  - [ ] Packet/task list.
  - [ ] Agent activity.
  - [ ] Review/PR panel.
  - [ ] Approval queue.
  - [ ] Context graph.
  - [ ] Settings / runtime configuration.
- [ ] Capture mobile screenshots for:
  - [ ] Mobile home.
  - [ ] Assistant chat.
  - [ ] Approval card.
  - [ ] Repo picker.
  - [ ] Offline/empty state.
- [ ] For each screenshot, record:
  - Route.
  - Viewport.
  - State seed or data source.
  - Date captured.
  - Feature status.
- [ ] Avoid using mock/preview screens in docs unless clearly labeled as preview.

## Phase 13 - Professional Docs Output Plan

After the audit, produce or refresh docs in this order:

- [ ] `README.md` - concise product entry, install/run commands, doc index.
- [ ] `docs/o8-product-brief.md` - canonical product story, audience, moats, v1 scope, what o8 is not.
- [ ] `docs/how-o8-works.md` - plain-English walkthrough plus verified technical architecture.
- [ ] `docs/system-architecture.md` - current architecture, data flows, storage, runtime boundaries.
- [ ] `docs/operator-guide.md` - how an operator actually uses o8 day to day.
- [ ] `docs/developer-guide.md` - how to run, validate, and extend the platform.
- [ ] `docs/runtime-adapters.md` - runtime contract, supported runtimes, capability matrix.
- [ ] `docs/governance-and-approvals.md` - policy engine, approvals, review, audit.
- [ ] `docs/projects-and-worktrees.md` - project/repo model, worktrees, branch safety, scope.
- [ ] `docs/mcp-and-cli-reference.md` - MCP tools and CLI commands.
- [ ] `docs/mobile-operator-guide.md` - mobile jobs, limitations, pairing/control flow.
- [ ] `docs/vocabulary.md` - public glossary plus internal divergence notes.
- [ ] `docs/changelog-docs-audit.md` - what was verified, changed, deprecated, and left open.

## Phase 14 - Verification Gates

- [ ] Run docs-only validation.
  - Command: `rg -n "TODO|TBD|maybe|probably|I think|air traffic control" README.md docs`
  - Command: `rg -n "Cortex IDE" README.md docs` and decide whether each instance should now say `o8`.
- [ ] Run static checks if docs reference code behavior.
  - Command: `npm run typecheck`
  - Command: `npm run lint`
  - Command: `npm run build`
  - If these are too expensive or blocked by unrelated dirty worktree issues, record the exact blocker.
- [ ] Run focused route/API smoke checks when claiming API behavior.
  - Use curl or browser only against local dev.
  - Capture status code, request body, response shape.
- [ ] Run UI screenshot verification for any docs that include screenshots or UI claims.
- [ ] Confirm no public doc claims that:
  - [ ] A planned feature is shipped.
  - [ ] A mock route is production.
  - [ ] A runtime is supported if it only exists as metadata.
  - [ ] A policy count is current without source verification.
  - [ ] Team/cloud/managed runtime exists if it is only future architecture.
- [ ] Final git review:
  - Command: `git diff -- docs README.md`
  - Command: `git status --short`

## Phase 15 - Automation Plan For Keeping Docs Current

Do not automate writing prose first. Automate evidence collection first.

- [ ] Create a generated source inventory:
  - Routes from `src/app`.
  - API methods and route files.
  - MCP tools and schemas.
  - CLI commands.
  - Runtime adapters and capability declarations.
  - Package scripts.
  - Tauri capabilities.
- [ ] Store generated inventory in a machine-readable docs artifact.
  - Candidate: `docs/generated/o8-source-map.json`.
- [ ] Add a docs freshness check that compares:
  - Source inventory vs docs references.
  - MCP tool list vs `docs/mcp-and-cli-reference.md`.
  - API routes vs architecture/API docs.
  - Runtime adapters vs runtime docs.
  - Vocabulary terms vs source labels.
- [ ] Add a docs PR checklist:
  - Every product behavior change updates affected docs or marks why not.
  - Every new MCP tool/API route/runtime updates generated inventory.
  - Screenshots regenerated only when UI meaningfully changes.
- [ ] Add a lightweight docs audit command later:
  - Candidate script: `scripts/docs-audit.mjs`.
  - Candidate command: `npm run docs:audit`.

## Phase 16 - Questions To Ask Q After Evidence Collection

Ask these only after the repo audit produces concrete options:

- [ ] Should public docs lead with `governance layer`, `agent command center`, or `operating system for agent work`?
- [ ] Which audience is first: solo technical operators, engineering managers, or internal dogfood users?
- [ ] Should docs describe Claude as the orchestrator and Codex as the workhorse, or use provider-neutral roles now?
- [ ] Which surfaces are allowed to be shown publicly while the product is still private?
- [ ] How much of mobile should be framed as shipped vs planned?
- [ ] Should `Cortex IDE` remain in historical docs only, with `o8` everywhere user-facing?

## Definition Of Done For The Audit

- [ ] Existing docs are classified as canonical, historical, stale, planned, or scratch.
- [ ] Product definition is backed by code and current docs.
- [ ] Surface map covers desktop, mobile, API, MCP, CLI, Tauri, and preview/mock routes.
- [ ] Runtime support matrix is verified from source.
- [ ] Task/packet/lane/mission/review/approval lifecycle is mapped end to end.
- [ ] Project/repo/worktree/context model is mapped end to end.
- [ ] Governance and audit claims are source-verified.
- [ ] Memory/Cortex claims are separated into shipped, partial, planned, and deprecated.
- [ ] Professional docs output list is prioritized.
- [ ] Open questions for Q are short, specific, and decision-oriented.
- [ ] A future docs freshness automation path is specified but not overbuilt.
