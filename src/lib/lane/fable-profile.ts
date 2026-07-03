/**
 * Fable Layer-B lockout — the native-tool strip that is Slice 1's biggest token
 * lever. Extracted OUT of orchestrator-session.ts (already 1013 lines, over the
 * 800-line ceiling) per house rules; the spawn path imports these helpers.
 *
 * EMPIRICALLY VERIFIED (claude 2.1.198, subscription stream-json REPL,
 * 2026-07-02): a `--disallowedTools <native>` deny rule blocks Claude's native
 * `Read` tool EVEN under `--dangerously-skip-permissions` — the hypothesized
 * "skip bypasses disallow" failure mode does NOT occur. So a Fable turn keeps
 * `--dangerously-skip-permissions` (its KEPT MCP tools — operator dispatch +
 * cortex ask — run autonomously, no permission-prompt hang) and layers the deny
 * rule on top. (Denylist-without-skip and allowlist+denylist-without-skip also
 * block Read, but they drop skip and add prompt/hang surface for the MCP tools
 * without adding blocking power — the deny rule does all the work in every case.)
 *
 * The deny list IS the token lever: it removes native context reads
 * (Read/Grep/Glob), native writes (Edit/Write/NotebookEdit), exec (Bash), web
 * (WebFetch/WebSearch), and the native subagent (Task). Fable reads + dispatches
 * through the operator + cortex MCP servers instead of burning tokens locally.
 */

import { resolveFableApiKey } from './orchestrator-backends/fable-config';

/**
 * Claude native tools stripped from a Fable turn. These are the recognized tool
 * names in the shipped `claude` CLI. `MultiEdit` is intentionally omitted: it is
 * not a known tool in the current CLI, so a deny rule for it only emits a
 * "matches no known tool" warning on every spawn (Edit already covers the case).
 */
export const FABLE_DISALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
] as const;

/**
 * MCP tools stripped from a Fable turn (Slice 3 — compact-return enforcement).
 * The operator + cortex servers ride on the fable profile so Fable can
 * orchestrate, but their RAW-TRANSCRIPT tools would let a 100K-token worker run
 * flow straight into the metered window. Denying them forces every hand-back
 * through the compact surfaces: the ~1.2KB `PacketContext` (context-relay) and
 * `get_mission_status`'s truncated review summary. `mission_tail` is
 * deliberately KEPT — it returns compact lane events (the audit stream), not
 * the transcript. Deny names use the claude-orchestrator wire keys from the
 * tool-spine catalog (`operator`, `cortex` — build.ts), same `--disallowedTools`
 * deny-rule mechanism the native strip uses (verified to fire under
 * `--dangerously-skip-permissions`, 2026-07-02).
 *
 * Fable-scoped ONLY: claude/codex/collide orchestrators keep both tools.
 *
 * The `mcp__o8__*` aliases cover the USER-SCOPE operator server (registered as
 * "o8" in ~/.claude.json): live dogfood (2026-07-02) showed the CLI merges
 * user-scope servers over the injected --mcp-config, and the model actually
 * picked the `mcp__o8__*` names — an un-denied raw-transcript path. The
 * `--strict-mcp-config` flag in `fableLockoutArgs` is the primary fix (only
 * the injected operator+cortex servers exist); the aliases are defense in
 * depth should the strict flag ever regress.
 */
export const FABLE_DISALLOWED_MCP_TOOLS = [
  'mcp__operator__o8_packet_transcript',
  'mcp__cortex__cortex_read_transcript',
  'mcp__o8__o8_packet_transcript',
  'mcp__o8__cortex_read_transcript',
] as const;

/**
 * The permission + native-tool-lockout args for a Fable turn — occupies the
 * `--dangerously-skip-permissions` slot in the spawn arg list. Keeps
 * skip-permissions (autonomous MCP orchestration, no hang) AND appends the
 * native-tool deny rule (the token lever, empirically verified to fire under
 * skip). `--disallowedTools` is variadic, so each tool name is its own argv
 * element (matches the verified probe invocation).
 */
export function fableLockoutArgs(): string[] {
  return [
    '--dangerously-skip-permissions',
    // Hermetic MCP surface: ONLY the injected operator+cortex config. Without
    // this, user-scope servers (~/.claude.json "o8") merge in with a full,
    // un-denied tool set — observed live 2026-07-02.
    '--strict-mcp-config',
    '--disallowedTools',
    ...FABLE_DISALLOWED_TOOLS,
    ...FABLE_DISALLOWED_MCP_TOOLS,
  ];
}

/**
 * Env override for a Fable proc: map the operator's BYO key onto
 * `ANTHROPIC_API_KEY` for THIS proc only. Returns `{}` when unset — it never
 * touches the ambient subscription procs (spreading a BYO `ANTHROPIC_API_KEY`
 * into them would re-bill them against API instead of the subscription pool).
 */
export function fableEnvOverride(): Record<string, string> {
  const key = resolveFableApiKey();
  // DISABLE_PROMPT_CACHING is force-cleared on the metered proc regardless of
  // ambient env: on API billing, uncached input re-meters at full price every
  // turn (verified 2026-07-03 — with caching on, turn 2 of a fable-shaped
  // spawn billed 2 fresh input tokens against 13.5K cache reads). Subscription
  // procs are unaffected (they don't get this override).
  const cacheGuard = { DISABLE_PROMPT_CACHING: '' };
  return key ? { ...cacheGuard, ANTHROPIC_API_KEY: key } : cacheGuard;
}
