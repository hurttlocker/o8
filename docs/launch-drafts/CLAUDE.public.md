# CLAUDE.md

This file guides Claude Code (and, via `AGENTS.md`, every other coding agent) when working in this repository.

## What Is This

**o8** is a Next.js 16 + Tauri v2 desktop app — **the governance layer for autonomous engineering teams**. Approvals, audit, organizational memory, and mobile operator control across any AI provider.

The shipping pattern: an orchestrator agent plans and reviews; worker agents execute in isolated git worktrees. The runtime catalog contains thirteen runtimes, twelve dispatchable, behind one capability-gated CLI adapter contract (`src/lib/runtimes/`). Desktop and mobile use separate surface-specific component trees while sharing selected infrastructure and common components. o8 runs on the subscriptions you already own — it spawns the same CLIs you'd run by hand (your ChatGPT/Codex plan, your Claude plan, your Gemini auth) and adds governance on top. No metered API keys are required for the core loop.

See `docs/how-o8-works.md` for the product story. Detailed topology and surface inventories live in `docs/system-architecture.md` and `docs/ui-surface-atlas.md`.

## Commands

```bash
# Development
npm run dev              # Next + ws-server together — defaults to 47120 / 47125
npm run dev:next         # Next.js dev server alone — defaults to http://localhost:47120
npm run dev:ws           # WebSocket server alone — defaults to ws://localhost:47125
cargo tauri dev          # Tauri native shell (from src-tauri/)

# Verification
npx tsc --noEmit                         # Quick type check
npm run typecheck                        # Clear generated types → next typegen → tsc
npm test                                 # Vitest suite
npm run rule-check -- --base=<ref>       # Changed-line UI, port, path, and file-ceiling rules
npx eslint <changed-files>               # ESLint on touched files
cargo test --lib                         # Rust unit tests (from src-tauri/)

# Build
npm run build            # Next.js production build (webpack)
npm run tauri:build      # Native app build
```

**Test runner: Vitest** (`vitest.config.ts`). Tests live colocated as `src/**/*.test.ts` plus cross-cutting suites in `tests/`. The `@` alias resolves; Next's `server-only` poison-pill is stubbed via `tests/stubs/server-only.ts`. Tests import `{ describe, it, expect }` from `'vitest'` explicitly (no globals). `tests/route-coverage.test.ts` walks every real API route and proves the middleware agrees with its expected policy; ordinary routes inherit the default gated policy. Add focused policy entries and middleware cases only for public, loopback-read, self-authenticating, capability-specific, or deliberately explicit gated seams. `tests/principal-authz.test.ts` exercises the operator/worker/remote capability matrix through real handlers.

### Real-path tests (the reachability rule)

**A new cross-process seam, prompt-taught tool argument, persistence path, or authorization check requires a test through the REAL entry point against persisted state — never the guard or helper in isolation.** Testing the mechanism with direct arguments while never exercising the path real callers take is the "green tests encode the premise" trap: the mechanism works, but nobody reaches it. We learned this the hard way — twice, a fully unit-tested guard shipped with hundreds of green tests while the real call path never reached it. Drive the actual route handler / prompt assembler / dispatch chain with a constructed Request (or persisted rows), and assert the observable effect. Patterns to copy: `tests/principal-authz.test.ts`, `tests/route-coverage.test.ts`, `tests/real-path-seams.test.ts`.

## CI Pipeline

Pull requests run typecheck, lint, unit tests, a dependency security audit, and the governance smoke on Node 22 with `npm ci`; the governance smoke depends on typecheck while the other jobs run independently. Manual dispatch runs the same checks plus the production build. Direct pushes do not trigger CI.

## Path Aliases

`@/*` maps to `./src/*`. Prefer it for imports that cross source domains; colocated relative imports are normal.

## Design Philosophy

**Steve Jobs lens.** Every pixel matters. Density with restraint. Progressive disclosure. If Apple wouldn't ship it, neither do we.

**Karpathy lens (Software 3.0).** Control plane, not an editor. Intent over instruction. Observable agents. Human oversight as a feature, not a bottleneck.

**Eye-ergonomics lens.** Tune icons, font weights, stroke widths, and contrast for the human eye — not for the design system's defaults. Sustained all-day legibility beats spec fidelity. The locked typography, icon, and layout values live in [`hurttlocker.md`](./hurttlocker.md) — read it before changing any row geometry, font weight, or chrome icon.

**Design language.** [`DESIGN.md`](./DESIGN.md) is the authoritative palette, typography, and motif vocabulary. [`STYLEGUIDE.md`](./STYLEGUIDE.md) covers the interaction half: feedback-timing tiers, sibling cohesion, button hierarchy.

## Architecture

For diagrams, current UI surfaces, and subsystem walkthroughs, use `docs/system-architecture.md` and `docs/ui-surface-atlas.md`. The contracts below are the parts agents must hold while changing code.

### Runtime catalog and adapter contract

`src/lib/orchestrator/runtime-capabilities.ts` is the canonical catalog: thirteen entries, twelve dispatchable, with the `OrchestratorRuntime` type inferred from its keys. A straightforward CLI normally needs one catalog entry plus coverage in `src/lib/runtimes/declarative-workers-smoke.test.ts`. A stateful or protocol-specific runtime normally needs an owned-session adapter, an `AgentRuntime`, a catalog entry, and registry registration; add a cost parser only when the runtime emits usable telemetry. Follow `docs/runtime-adapter-contract.md`, not a fixed file-count recipe.

The UI and API consume the registry and capability contract, not vendor protocols. The `AgentRuntime` lifecycle uses `discoverSessions`, `readTranscript`, `launch`, `resume`, `interrupt`, and `getChangedFiles`, with telemetry optional.

### Orchestrator backend versus worker runtime

The active orchestrator backend and the dispatched worker runtime are independent selections. Never infer one from the other: inspect `src/lib/lane/orchestrator-backends/active-backend.ts`, the backend registry, and the runtime catalog before changing routing.

Ad-hoc LLM calls go through the existing proxy and routing layer. `src/lib/chat/gateway-client.ts` is the sanctioned AI SDK import boundary; do not add `ai` or `@ai-sdk/*` imports elsewhere without an explicit architecture change.

### Dynamic ports

Development defaults to API `47120` and WS `47125`; packaged instances choose free ports from reserved blocks and write `~/.o8/api-port` and `~/.o8/ws-port`. Never hardcode a backend port. Server code uses `getApiBase()`, `getWsBase()`, or `resolvePortInfo()` from `src/lib/panel/api-port.ts`; standalone CLI and MCP code uses its existing resolver.

### API security

Global Node middleware in `src/middleware.ts` is default-deny for `/api/*`. An operator bearer is valid on every API route; loopback is transport context, not identity, and does not replace the bearer except for a narrow read-only capability list. Public and self-authenticating routes are explicit exceptions, and non-loopback requests need an affirmative credential.

New routes inherit the gated policy without a manifest entry. To add public, loopback-read, self-authenticating, or principal-specific access, add the narrow middleware policy, verify any in-handler credentials, and update `tests/route-coverage.test.ts` plus focused cases in `tests/middleware-gate.test.ts`. `/api/setup/*` is not a public family; only `/api/setup/identity` has narrow loopback-read access. See `docs/loopback-api.md`.

### MCP schemas

For MCP tools consumed by OpenAI strict mode, keep the top-level `inputSchema` a plain `{ type: 'object', properties, required }`. Do not put `oneOf`, `anyOf`, `allOf`, or `not` beside that object; validate unions and conditional relationships in the handler so one incompatible schema cannot suppress the whole tool list.

### Database and local state

Local state defaults to `~/.o8`; `O8_DATA_DIR` is the primary override and `CORTEX_IDE_DATA_DIR` is its legacy alias. The main SQLite database defaults to `<data-dir>/cortex-ide.db`, uses WAL and foreign keys, and initializes through `getDb()`. Typed declarations live in `src/lib/db/schema.ts`, while creation and migration truth also lives in `src/lib/db/index.ts` and the versioned migration modules.

### Theming

The theme system has two axes: light/dark palette and glass/solid surface, with an explicit All Glass workspace mode layered through the same token system. Themeable components use `var(--t-*)` tokens in inline styles; do not hardcode surface opacity or add rgba-white surfaces outside the theme registry. Geometry comes from `hurttlocker.md`, `DESIGN.md`, adjacent components, and the relevant touch or desktop context rather than one global radius or touch-target constant.

### Merge governance and escalation

Workers cannot merge their own packets. A worker-side approve-merge request raises an operator approval card; an authenticated dispatcher still goes through review and the merge gate. When post-rebase typecheck fails, recovery escalates without silently stalling:

| Layer | Trigger | Who decides |
|---|---|---|
| 1. Auto-rerun, capped at one | merge typecheck fails | system |
| 2. `awaiting_orchestrator` | the retry also fails | system → orchestrator |
| 3. Steer the warm session | fix in place | orchestrator |
| 4. Fresh redispatch | steering fails or the session is dead | orchestrator |
| 5. Human approval card | automated recovery is exhausted | operator |

`reset_packet` followed by dispatch resets the layer-one retry budget. Prefer steering the warm session when it is healthy because it retains packet context.

## Critical Rules

> **Vocabulary** — [`docs/vocabulary.md`](./docs/vocabulary.md) is the canonical glossary of `runtime` / `agent` / `session` / `packet` / `lane` / `mission` / `review` / `approval`. MCP tool names and DB columns are frozen for stability.

### NEVER

- **Never introduce new `className` or CSS classes in TSX** — use inline style objects. Existing legacy classes are not precedent.
- **Never hardcode rgba-white colors for theme surfaces** — use the matching `var(--t-*)` token.
- **Never hardcode backend ports** — use the shared resolver.
- **Never hardcode absolute user paths** — use `process.cwd()`, `os.homedir()`, `process.env.HOME`, or an explicit environment variable.
- **Never bypass the middleware gate** — exceptions require an explicit policy and real-path tests.
- **Never add emoji UI** — use raw SVG icons matching the surrounding surface.
- **Never add React icon-library imports under `src/components/desktop/`** — use the established raw-SVG/shim pattern.
- **Never use Material Design patterns** — no `borderLeft` accents or MD elevation.
- **Never use dropdown overflow menus (`...`)** — use inline actions with confirmation strips.
- **Never put an early `return null` before hooks.**
- **Never add multi-value `padding` or `margin` shorthand** — use longhand properties so React cannot mix shorthand and longhand.
- **Never throw from API routes** — return structured error responses.
- **Never use native `<select>` or `<input>` inside packet cards** — use Issues-style rows and custom popovers.

### ALWAYS

- **Run `npx tsc --noEmit` before every commit.**
- **Respect the 800-line file ceiling.** Current mechanical waivers are `src/app/dashboard/page.tsx`, `src/ws-server.ts`, `src/lib/worktree/manager.ts`, and `src/lib/lane/commands.ts`; new waivers require an explicit decision.
- **Run `npm run rule-check -- --base=<ref>` for changed TypeScript or TSX.**
- **Use `as React.CSSProperties` for vendor-prefixed CSS properties.**
- **Build through the runtime contract** — never wire product callers directly to one vendor protocol.
- **Prefix console logging with `[feature-name]`.**
- **Use Conventional Commit prefixes:** `feat:`, `fix:`, `refactor:`, `perf:`, or `chore:`.
- **Smoke-test scripts with `tsx <script>`, never `tsx -e "import(...)"`** — the latter can silently lose named exports.

## Environment Variables

Most local configuration is optional and fresh clones boot without it. State defaults to `~/.o8`; set `O8_DATA_DIR` to isolate or relocate it. `CORTEX_IDE_DATA_DIR` remains a legacy-compatible alias and has lower precedence.

## Git Practices

- Maintainers may work on `main`; contributors branch and open pull requests.
- Keep `npx tsc --noEmit` and `npm test` green before every commit.
- In agent workflows, stage explicit pathspecs; never use bare `git add -A` or `git add .`.

## Documentation

- `docs/system-architecture.md` — system diagram and subsystem topology
- `docs/ui-surface-atlas.md` — current desktop and mobile surface inventory
- `docs/runtime-adapter-contract.md` — declarative and specialized runtime recipes
- `docs/loopback-api.md` — API authentication and middleware policy
- `docs/canonical-workflow.md` — dispatch → review → merge
- `docs/vocabulary.md` — canonical control-plane terms
- `docs/performance-architecture-principles.md` — render, bootstrap, and streaming contracts
- `docs/product-telemetry-privacy.md` — opt-in telemetry posture
