# REVIEW.md — o8 Code Review Rules

When reviewing pull requests for this repository, enforce these rules. Flag violations as inline comments with severity: **blocker**, **warning**, or **nit**.

## Blockers (must fix before merge)

### Style violations
- **No CSS classes.** All styling must use inline `style={{ }}` props. This is permanent — iOS Safari reliability issue.
- **No CSS shorthand.** Use `paddingTop`/`paddingLeft`, not `padding: "8px 16px"`. React 19 warns on mixed shorthand/longhand.
- **No emoji anywhere.** Use Lucide icons only across all surfaces.
- **No Material Design patterns.** No `borderLeft` accents, no MD elevation shadows.

### React safety
- **No early `return null` before hooks.** All hooks must run in the same order every render. Conditional returns must come after all hook calls.
- **No state updates in effects without proper dependency guards.** This causes render loops — the most common bug in this codebase.
- **No missing effect cleanup.** Every `useEffect` that creates subscriptions, timers, or event listeners must return a cleanup function.

### API route safety
- **Never throw in API routes.** Return structured error responses with appropriate status codes.
- **Never use the `ai` SDK.** Direct fetch to `/api/v2/proxy/llm` route only.

### Runtime safety
- **Never use OpenClaw CLI for status/session queries.** Use WebSocket RPC via `wsRpc()`. The CLI hangs indefinitely on some configurations.
- **Never spread `...statusResult` AFTER session data.** The status RPC response has its own `sessions` key that clobbers real data. Always spread BEFORE.

### Security
- **Command injection** — Check all `execSync`/`exec` calls for unsanitized user input.
- **Path traversal** — Check all file path construction for `../` injection.
- **No secrets in code** — No API keys, tokens, or credentials in committed files.

## Warnings (should fix, can discuss)

### Architecture
- **Gateway communication must go through WebSocket RPC** — `wsRpc()` in `gateway-client.ts` is the primary path, not CLI fallback.
- **Build for all three runtimes** — Changes should not assume a single provider (OpenClaw, Codex, Claude Code).
- **Console logging must use `[feature-name]` prefix** — e.g., `[memory-recall]`, `[compaction]`.

### Performance
- **Watch for N+1 patterns** — Especially in API routes that loop over agents/sessions and make individual fetch calls.
- **Check for unnecessary re-renders** — Components that create new objects/arrays in render without `useMemo`/`useCallback`.
- **Large state in effects** — Effects that depend on frequently-changing state (like message arrays) should use refs for values they only read.

### TypeScript
- **Use `as React.CSSProperties`** when using vendor-prefixed or non-standard CSS props in inline styles.
- **No `any` types** unless absolutely necessary. Prefer `unknown` with type narrowing.

## Nits (nice to fix, not blocking)

- **Commit message format** — Should use `feat:`, `fix:`, `refactor:`, `perf:`, `chore:` prefix.
- **Apple HIG compliance** — 44px minimum touch targets, 14px card radii, spring animation curves.
- **Design constants** — Accent blue is `#2563eb`, not custom blues. Check `CLAUDE.md` for full palette.
- **Import aliases** — Use `@/lib/...`, `@/components/...` path aliases, not relative paths.

## What NOT to flag

- Missing tests — there is no test runner configured.
- Missing JSDoc/comments — only flag if logic is genuinely unclear.
- Code style preferences that aren't in the rules above.
- Unused imports — the linter catches these.
- File organization suggestions — the structure is intentional.

## Context for reviewers

This is a Next.js 16 + Tauri v2 desktop app (o8, formerly Cortex IDE). It's a multi-provider agent control plane where Claude orchestrates and Codex executes. The codebase has 120+ API routes, 37+ library domains, and separate desktop/mobile surfaces. Development is rapid iteration on `main` branch.

Key architectural decisions:
- Inline styles only (no CSS classes)
- CLI-based runtime adapters (not API)
- WebSocket RPC for OpenClaw gateway (not CLI)
- Separate desktop and mobile codebases by design
- SQLite via better-sqlite3 + Drizzle ORM

See `CLAUDE.md` for full project rules and `docs/user/o8-product-brief.md` for product context.
