# Project Hardening Contract

Projects are the product-level container in o8. A project can own multiple repos
with roles, instructions, sessions, packets, locks, and retrieval scope. Repos
remain the unit of filesystem work; projects decide how those repos relate.

## Current Contract

1. Single project context
   - `src/lib/projects/context.ts` resolves one normalized `ProjectContext`.
   - The context merges the desktop rail ledger (`~/.o8/projects.json`) with the
     richer Settings/Cortex project store (`projects` and `project_repos` in
     SQLite).
   - `/api/projects/context` returns the resolved project, repos, roles,
     instructions, active repo, related repos, and a compiled task brief.

2. Repo roles
   - Settings projects store per-repo roles in `project_repos.role`.
   - Known roles include `fullstack`, `mobile`, `site`, `service`, `infra`,
     `library`, `docs`, `frontend`, `backend`, and `shared`.
   - Rail-only repos are mirrored into SQLite with an inferred role so backend
     consumers can stop treating membership as display-only.

3. Project-scoped sessions
   - Lanes now persist `projectId`.
   - New lane creation resolves the project from the repo path before writing
     the lane row, so work spawned in `o8-mobile` can still belong to the `o8`
     product context.

4. Task brief compiler
   - `buildProjectTaskBrief()` turns a `ProjectContext` into a concise worker
     brief: project, primary repo, sibling repos, instructions, repo policy, and
     output policy.
   - Dispatch context injection now includes a `Project Scope` section so worker
     prompts know which sibling repos are relevant.
   - `/api/orchestrator/delegate` now launches workers with this brief attached
     and records the resolved project id on the lane.

5. Retrieval scope
   - `getActiveProjectScopeForRepo()` now resolves the project that contains the
     requested repo path, falling back to the active project only when no match
     exists.
   - FTS, facts, and structured SQL retrieval include sibling repos from the
     resolved project when a primary repo is explicit. The primary repo gets a
     light ranking boost, while sibling repos remain available for cross-repo
     context.
   - This makes existing Cortex, directives, outcomes, approvals, and dispatch
     consumers safer for multi-repo projects without each caller reimplementing
     repo-to-project lookup.

6. Visible locks
   - `/api/projects/locks` lists active lanes as project locks.
   - Locks include project, repo, lane, packet, runtime, branch, status,
     heartbeat, and stale state.
   - This is the backend surface for a future control-room UI that shows who
     owns which repo/path/task.

7. UI and management bridge
   - Settings project mutations sync back into the desktop rail ledger.
   - Rail project membership syncs into SQLite before project context reads and
     before `/api/projects` lists projects.
   - GitHub org suggestions only propose unassigned repos and suppress broad
     org-wide suggestions once an existing multi-repo project already covers
     that org.
   - The current source of truth is therefore the resolved context, not either
     raw store by itself.

## Expected Behavior For `o8`

When `o8` contains `cortex-ide`, `o8-site`, and `o8-mobile`:

- `cortex-ide` remains the main product repo.
- A mobile task can still mark `o8-mobile` as the current repo.
- The task brief should mention `cortex-ide` as main, `o8-mobile` as current
  when scoped there, and `o8-site` as a related repo.
- Retrieval should prefer the current repo for repo-specific answers while still
  allowing the main and sibling repos to contribute cross-repo context.
- Locks should be attached to the `o8` project even when a worker is currently
  editing only one repo.
- Project instructions should be treated as product-level guidance and included
  in worker context.

## Follow-Up Work

- Add project files as first-class context records instead of the current
  placeholder.
- Add explicit primary/related repo fields to packet creation so the operator
  can override the inferred primary repo.
- Render `/api/projects/locks` in the desktop control room.
- Add project-aware route tests once this repo has a test runner.
