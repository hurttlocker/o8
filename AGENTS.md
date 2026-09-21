# o8 Repository Rules

These are the canonical operating rules for agents working in this repository. Read the sections
that apply to the current task once. Load scoped references only when their trigger applies.

## Outcome ownership and authority

- Turn the request into an observable outcome. Separate symptoms, established facts, hypotheses,
  and root cause. Choose the smallest complete remedy inside the requested scope.
- Read-only or diagnostic work stays non-mutating. A change request includes implementation,
  proportionate verification, a focused commit, push, and pull request. An operator or lead agent may
  merge a reviewed CI-green pull request under standing authorization; implementation workers and
  packets never self-approve or merge. Version bumps, releases, production changes, public posts,
  destructive actions, spending, credentials, and another person's machine remain operator gates
  unless the current task explicitly authorizes them.
- Preserve dirty worktrees and unrelated edits. Inspect status before editing, use explicit
  pathspecs, and never discard, stash, reset, or rewrite work you do not own.
- A plan, test, commit, merge, or delivered message is evidence, not automatic proof. Verify through
  the real entry point and report Outcome, Evidence, Residual, and Decision.
- If blocked, preserve state and report the exact blocker, evidence, and shortest safe unblock.

## Execution and delegation

- One execution agent owns ordinary work end to end. Direct execution is the default when it is the
  cheapest complete path.
- Delegate only when a bounded benefit outweighs briefing, review, retry, and context costs, or when
  independence or risk requires a separate seat. File count, task size, and the existence of a model
  ladder do not require delegation. Do not add a classifier call by default.
- Pin the delegated model and effort. Preserve the operator's selected model and effort for the main
  task. Use roles such as scout, worker, builder, and panel to describe the job, not as a dispatch
  requirement.
- Define a delegated seat's scope, done condition, verification, and compact handback before launch.
  Review its actual diff and receipts. After two correction rounds on delegated implementation,
  stop repeating the loop and report or escalate with the remaining defect.
- Use scripts or bounded wait tools for routine polling. Use an independent reviewer for raw
  security, authentication, authorization, schema, payment, destructive, or other high-risk evidence.
  Frontier judgment is selective, not a mandatory review of every routine fix.
- Judge efficiency by the whole accepted task: model calls, retries, review, corrections, wall time,
  subscription use, API cost, and acceptance. Native subscription agents share allowance. Token
  counts do not prove weekly allowance use or savings.

## Repository invariants

- o8 is a Next.js 16 and React 19 app in a Tauri v2 shell. Desktop and mobile are separate surfaces.
  Orchestrator backends in `src/lib/lane/orchestrator-backends/` and worker adapters in
  `src/lib/runtimes/` are separate systems. Inspect the current registries before changing routing.
- Runtime code is the source of truth for ports, routes, commands, and registrations. Never hardcode
  API or WebSocket ports, user home paths, or stale inventory counts. Use the existing resolvers and
  registries.
- API middleware is default-deny for `/api/*`. Public routes require deliberate narrow allowlisting;
  externally reachable self-authenticating routes must verify their own credentials. Return structured
  route errors rather than throwing to the framework.
- TypeScript is strict. Use the existing two-space, single-quote, semicolon style and `@/` imports.
  The default file ceiling is 800 lines; existing waivers do not authorize new ones.
- In TSX, add no new CSS classes. Use inline style objects, longhand spacing when values differ,
  theme variables for themeable surfaces, and the established raw-SVG icon pattern. Keep hooks
  unconditional and in stable order.
- Ad-hoc model calls use the existing proxy and routing layer. The sanctioned AI SDK import boundary
  is `src/lib/chat/gateway-client.ts`. Strict-mode MCP schemas keep a plain top-level object; validate
  conditional relationships in the handler.

## Verification and GitHub work

- Every code change runs `npx tsc --noEmit` and the hermetic `npm test` completion gate. Run the
  smallest relevant tests while iterating, and use integration or Rust tests when the changed
  boundary requires them. Docs-only changes validate links and the affected documentation checks.
- New cross-process seams, prompt-taught arguments, persistence paths, and principal or authorization
  changes need a test through the real entry point and persisted state. Helper-only tests are not
  reachability proof.
- Run `npm run rule-check -- --base=<ref>` for changed TypeScript or TSX and ESLint only on touched
  files. Read `.github/workflows/ci.yml` before describing current CI.
- For issues and pull requests, load `~/.codex/skills/github-ops-standard/SKILL.md` once. Public
  artifacts describe the mechanic without adding private identities, machine details, credentials,
  billing notes, or internal routing notes. Scan logs and screenshots before posting. Do not silently
  rewrite already-published material or Git history to remove a prior disclosure; escalate it.
- In packet worktrees, stay inside packet scope and use `o8 packet commit`. Outside packets, use a
  focused Conventional Commit and one pull request per issue. Implementation workers and packets
  never self-approve or merge; the operator or lead agent applies the standing reviewed-green merge
  rule above.
- Use `o8 team who`, `o8 team status`, `o8 team tell`, and named leases when concurrent agents are
  active. Check `o8 lane touches --path <file>` before overlapping another packet.

## Scoped references

- Command families, detailed CLI syntax, repository map, visual-proof flow, and Brain contribution:
  [`AGENT_REFERENCE.md`](./AGENT_REFERENCE.md). Read only the section
  needed for the task.
- Architecture and extension contracts: [`docs/internals/system-architecture.md`](./docs/internals/system-architecture.md),
  [`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md), and the
  implementation named above. Historical inventories in docs are orientation, not runtime truth.
- UI work: read [`docs/design/hurttlocker.md`](./docs/design/hurttlocker.md), then
  [`docs/design/DESIGN.md`](./docs/design/DESIGN.md) and [`docs/design/STYLEGUIDE.md`](./docs/design/STYLEGUIDE.md).
- Release work: load [`.agents/skills/ship/SKILL.md`](./.agents/skills/ship/SKILL.md) and the relevant
  runbook under [`docs/operations/`](./docs/operations/). Do not load release procedures for ordinary
  development, and never run `npm run ship` without current-session operator approval.
- Symon, recording, browser, or other specialized work loads only its named skill or runbook.

If the `o8` command is unavailable, use `o8 doctor --repair` after the app is reachable. If the local
control plane is unavailable, continue only with work that does not depend on packet mutation and
report the missing verification boundary.
