# Workspace Storage Path Decision

> **Superseded by #1594 (2026-07).** Managed worktrees now default to
> `~/.o8/worktrees/<repo-key>/.cortex-worktrees/`, configurable with
> `O8_WORKTREE_ROOT`. `src/lib/worktree/root-layout.ts` still discovers
> repository-local `.cortex-worktrees/` stores for backward compatibility.
> The remainder records the earlier repo-local decision.

## Context

At the time of this decision, worktree isolation stored managed worktrees under
`.cortex-worktrees/` inside each repository root. The alternative was a global
storage root.

This note evaluates the tradeoff for repository onboarding and recommends whether to change the storage model.

## Option A

Store worktrees inside the repo root:

- Path example: `<repo>/.cortex-worktrees/<workspace-id>`
- Metadata stays next to the repo in `<repo>/.cortex-worktrees/.meta.json`
- Existing `WorktreeManager` and setup flow already assume this layout

## Option B

Store worktrees outside the repo root:

- Path example: `~/.cortex-ide/worktrees/<repo-name>/<workspace-id>`
- Repo root stays visually cleaner
- All workspaces are centralized under one Cortex-owned directory

## Recommendation

Keep the current repo-local layout for now.

## Why

1. The current worktree manager, metadata store, and setup heuristics already operate on repo-local paths. Changing the root now would add migration work without unlocking the core onboarding value.
2. Repo-local worktrees are easier to reason about during first-pass onboarding. A user adds one local repo and immediately gets a visible, colocated workspace tree under that repo.
3. Existing setup behavior benefits from proximity to the main repo. Symlinking `node_modules`, copying env files, and debugging relative paths are simpler when the worktree root lives beside the primary checkout.
4. Git worktrees behave best when Cortex does not have to invent a second naming and cleanup layer outside the repo. Repo-local storage keeps cleanup, pruning, and manual inspection straightforward.

## Costs Of The Alternative

- Cortex would need a repo-slug naming scheme to avoid collisions across similarly named repos.
- We would need migration logic for existing `.cortex-worktrees/.meta.json` data.
- Setup hooks would need extra care for relative paths, symlink targets, and same-filesystem assumptions.
- Central storage improves cleanliness, but it makes “where did my workspace go?” less obvious during early onboarding.

## Revisit Triggers

Re-evaluate an external storage root if one of these becomes true:

- Users register many repos and want a single storage budget or cleanup surface
- Repo-local worktrees create noticeable noise for tooling, indexing, or backups
- Cortex adds shared storage policies, quotas, or background garbage collection across repos

## Decision

Ship repository onboarding on top of the current `.cortex-worktrees` layout and defer any storage-root migration to a follow-up issue once multi-repo usage proves the need.
