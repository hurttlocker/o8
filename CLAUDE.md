# Claude Code in o8

[`AGENTS.md`](./AGENTS.md) is the canonical repository policy for every agent. Read it once when a
task begins or when its scope changes. Do not load every linked manual by default.

## Claude-specific execution

- One Claude execution agent handles ordinary tasks directly. Use a subagent only when the bounded
  benefit exceeds briefing, review, retry, and context costs, or when an independent high-risk review
  is required. A large read set or an available agent roster does not require delegation.
- Pin every delegated model and effort, preserve the operator's selected model and effort for the
  main task, and review the delegated diff and receipts. After two correction rounds on delegated
  implementation, stop the loop and report or escalate the remaining defect.
- Use scripts or bounded wait tools for routine polling. Do not add a classifier call unless measured
  evidence shows that it improves the accepted task after its own cost.
- Load relevant skills and references once per task, then reuse them until the file changes or the
  task enters a materially different scope. Communication rules apply when drafting the response;
  they do not require repeated file reads before every reply.
- Treat hooks as safeguards, not proof. Preserve packet, worktree, approval, and operator gates in
  `AGENTS.md` even when a tool can technically bypass them.

## Task routing

- Commands, repository orientation, the full `o8` CLI surface, visual proof, and Brain workflows are
  in [`AGENT_REFERENCE.md`](./AGENT_REFERENCE.md). Read only the
  relevant section.
- Current architecture comes from implementation plus [`docs/internals/`](./docs/internals/).
  Historical counts and backend inventories are orientation only.
- UI work reads the design sources linked from `AGENTS.md`. Release work loads the ship skill and the
  relevant operations runbook. Ordinary development does not load release or platform manuals.
- Before stating CI behavior, read [`.github/workflows/ci.yml`](./.github/workflows/ci.yml). Before
  changing runtime routing, ports, authentication, or API exposure, inspect the current registry,
  resolver, middleware, and real-path tests.

Keep public repository artifacts free of new private identities, machine details, credentials,
billing notes, and internal routing notes. Do not rewrite public history to conceal an earlier
disclosure; escalate it to the operator.
