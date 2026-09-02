/**
 * Read-only worker lockout for the owned Claude Code runtime.
 *
 * A packet dispatched with `launchContext.workMode === 'read-only'` used to be
 * governed by prompt text alone while the process still launched under
 * `--permission-mode bypassPermissions`. Prompt compliance is not enforcement:
 * the worker could edit the worktree and nothing stopped it.
 *
 * The deny rule below is the CLI-level enforcement seam. `--disallowedTools`
 * blocks a native tool EVEN under skip-permissions — empirically verified
 * against the shipped `claude` CLI and already relied on by the Fable profile
 * (`src/lib/lane/fable-profile.ts`) and the solo orchestrator profile
 * (`CLAUDE_SOLO_DISALLOWED_TOOLS`). The model cannot call a denied tool at all;
 * there is no prompt to talk it out of.
 *
 * `bypassPermissions` is deliberately KEPT alongside the deny rule instead of
 * switching to `--permission-mode plan`. An owned worker is a one-shot
 * stream-json process with no permission responder, so a plan-mode escalation
 * emits a `can_use_tool` event nobody answers and the turn stalls. The deny
 * rule refuses without prompting, which is what a read-only run needs.
 *
 * Bash still runs (read-only packets need `git log`, `o8 ask`, `o8 packet
 * report`), so shell-level writes are closed by the OS layer instead — the
 * seatbelt profile write-denies the worktree for read-only runs
 * (`owned-session/sandbox.ts`).
 */

/**
 * Native Claude tools that can mutate the repository, denied for a read-only
 * packet. `Task` is included because a native sub-agent inherits the parent's
 * tool surface and would otherwise be an un-denied write path.
 */
export const CLAUDE_READ_ONLY_DISALLOWED_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Task',
] as const;

/**
 * Ignore every user- and project-scope MCP server; honour ONLY the servers in
 * the `--mcp-config` file o8 generated for this packet.
 *
 * Without it the deny rule above is bypassable: `--disallowedTools` names the
 * NATIVE write tools, but a user-scope MCP server merged in from
 * `~/.claude.json` contributes tools under its own `mcp__<server>__*` names,
 * which the deny list does not cover and which can write files. A read-only
 * packet must not inherit whatever the operator happens to have configured.
 */
export const CLAUDE_STRICT_MCP_CONFIG_FLAG = '--strict-mcp-config';

/**
 * The argv fragment appended to a read-only worker launch. Empty for a normal
 * write packet, so those launches stay byte-identical to before.
 */
export function claudeReadOnlyLockoutArgs(readOnly: boolean): string[] {
  return readOnly
    ? ['--disallowedTools', ...CLAUDE_READ_ONLY_DISALLOWED_TOOLS, CLAUDE_STRICT_MCP_CONFIG_FLAG]
    : [];
}
