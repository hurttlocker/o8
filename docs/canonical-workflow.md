# o8 — Canonical Task Workflow

> This is the foundational product workflow. All features serve this loop.
> Last updated: 2026-03-16

## The Flow

```
1. CREATE    → User creates Issue (or Epic if bigger) on GitHub
2. AUGMENT   → AI enriches: context, acceptance criteria, approach
3. ASSIGN    → User assigns to running agent or spins up new one
4. GATHER    → Agent reads Cortex memory + repo + user context sources
5. PLAN      → Agent produces structured plan, posts for review
6. REVIEW    → User approves (agent executes) or redirects (new agent)
7. EXECUTE   → Agent works in isolated worktree, opens PR
```

## Execution Model

```
Issue #349 created
    ↓
Agent reads Cortex + repo + user vault + configured context
    ↓
git worktree add /tmp/cortex-ide-349 -b feat/349-description
    ↓
Agent works in isolation (main stays clean)
    ↓
Plan posted to issue as comment → user reviews
    ↓
User approves → agent codes in worktree
    ↓
git push → PR opened from worktree branch
    ↓
Review agent validates (optional) → user merges
    ↓
Worktree cleaned up after merge
```

## Why This Works

- **Worktree isolation**: Each agent gets its own directory. No conflicts. Main never touched.
- **Multiple agents simultaneously**: Different agents on different issues, no stepping on each other.
- **Damage containment**: Agent goes off the rails → `git worktree remove` and it's gone.
- **GitHub is source of truth**: Plans, PR links, status tracking all native.

## Integration Priority

1. **GitHub** — first and foundational (issues/epics as task backbone)
2. **Slack** — later as plugin on same workflow
3. **Linear / Jira** — later as plugins
4. **Local issue tracking** — possible via git-based tools, but GitHub is the default

## Agent Priority

1. **OpenClaw agents** — build for these first (open source, we know them)
2. **Terminal agents** — Codex, Claude Code, etc. added after OpenClaw works

## Key Principles

- GitHub connection in Settings is the entry point for everything
- The workflow is the product — every feature serves this loop
- AI augmentation happens at creation time (currently Gemini free tier)
- Plans are ALWAYS reviewed before execution — human in the loop
- Agents read Cortex + Vault + GitHub before planning — context is king
