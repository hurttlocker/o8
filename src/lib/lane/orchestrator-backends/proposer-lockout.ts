/**
 * Proposer read-only lockout — the safety spine of Collide (MoA).
 *
 * A Collide PROPOSER forms an independent opinion but must be physically unable
 * to (a) write the repo or (b) dispatch work to a worker. Two STRUCTURAL layers
 * enforce this before this guard ever fires:
 *
 *   1. DISPATCH lockout — the proposer turn runs with `toolProfile: 'propose'`,
 *      which strips the o8 operator MCP server (dispatch_mission / create_mission
 *      / approve_and_merge …) from its config. No operator server → the
 *      proposer's runtime has no dispatch tool to call at all. (#1075.)
 *   2. EXECUTE lockout — the proposer turn runs with `permissionMode: 'plan'`:
 *      Codex gets an OS-level read-only sandbox (`sandbox_mode=read-only`);
 *      Claude gets `--permission-mode plan`, and because the orchestrator REPL
 *      closes stdin after the turn message, a write that asks for approval can
 *      never BE approved — it cannot land.
 *
 * This module is layer 3: a defense-in-depth runtime guard the MoA engine runs
 * over EVERY proposer event. If a write or dispatch `tool_use` ever reaches it —
 * i.e. layers 1-2 regressed — it throws a HARD ERROR rather than letting a
 * "read-only" proposer act. That throw is the regression test's tripwire; the
 * single most important safety test in Collide asserts it fires.
 */

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

/** Native write/execute tool names — Claude Code + Codex. */
const WRITE_EXECUTE_TOOLS = new Set([
  // Claude Code native
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash',
  // Codex
  'shell', 'local_shell', 'apply_patch',
]);

/**
 * o8 operator-MCP dispatch/governance verbs. Matched by name so the guard is
 * surface-independent: Claude prefixes MCP tools `mcp__operator__<verb>`, Codex
 * surfaces them `operator__<verb>`. The whole operator namespace is forbidden to
 * a proposer (the propose profile removes that server entirely), and the bare
 * dispatch/governance verbs are caught defensively in case a surface renames it.
 */
const DISPATCH_TOOL_PATTERN =
  /^mcp__operator__|(?:^|__)(?:dispatch_mission|create_mission|approve_and_merge|submit_review|rerun_with_feedback|retry_packet|reset_packet|steer_packet|o8_send|o8_approve|o8_reject)\b/i;

/**
 * cortex is a MIXED surface — read tools live alongside MUTATORS, most
 * dangerously `cortex_launch_agent` (it POSTs /api/orchestrator/delegate and
 * dispatches a worker). This is the ONLY set of cortex tools a read-only
 * proposer may call. ALLOWLIST, not denylist: anything else on the cortex server
 * — every mutator, and any cortex tool added later — classifies as dispatch and
 * fails closed. Mirrors `CORTEX_READONLY_TOOLS` in cortex-mcp-server.ts (the
 * structural read-only profile); keep the two in sync.
 */
const CORTEX_READONLY_TOOLS = new Set<string>([
  'cortex_ask',
  'cortex_read_packets',
  'cortex_read_transcript',
  'cortex_fleet_status',
  'cortex_list_approvals',
  'cortex_list_issues',
  'cortex_list_prs',
  'cortex_list_projects',
  'cortex_ci_status',
]);

/**
 * If `name` is a cortex-server tool, return its bare tool name; else null.
 * Handles Claude (`mcp__cortex__<tool>`), Codex (`cortex__<tool>` / `cortex.<tool>`),
 * the bare `cortex_*` verb form, and the two non-`cortex_`-prefixed cortex tools
 * (`lane_touches`, `register_mcp`) so the allowlist check below is fail-closed.
 */
function cortexToolName(name: string): string | null {
  const m = /^(?:mcp__cortex__|cortex__|cortex\.)(.+)$/i.exec(name);
  if (m) return m[1];
  if (/^cortex_/i.test(name)) return name;
  if (name === 'lane_touches' || name === 'register_mcp') return name;
  return null;
}

export type ProposerToolClass = 'write' | 'dispatch' | 'safe';

/** Classify a tool name from a read-only proposer's perspective. */
export function classifyProposerTool(name: string): ProposerToolClass {
  if (DISPATCH_TOOL_PATTERN.test(name)) return 'dispatch';
  // cortex MIXED surface — only the allowlisted read tools are safe; every other
  // cortex tool (mutators, dispatch like cortex_launch_agent, unknown) → dispatch.
  const cortex = cortexToolName(name);
  if (cortex !== null) return CORTEX_READONLY_TOOLS.has(cortex) ? 'safe' : 'dispatch';
  // Any OTHER MCP-namespaced tool is an EXTERNAL (user-configured) server tool —
  // proposers get NO external servers (the propose profile strips them), so an
  // `mcp__<server>__*` that reached here is a leak. Fail closed (belt-and-suspenders
  // to the structural strip; reverses the fail-open default that hid the cortex hole).
  if (/^mcp__/i.test(name)) return 'dispatch';
  if (WRITE_EXECUTE_TOOLS.has(name)) return 'write';
  return 'safe';
}

/** Thrown when a read-only proposer attempts a write or dispatch tool. */
export class ProposerLockoutError extends Error {
  readonly toolName: string;
  readonly toolClass: 'write' | 'dispatch';

  constructor(toolName: string, toolClass: 'write' | 'dispatch', proposerLabel: string) {
    super(
      `Collide proposer "${proposerLabel}" attempted a ${toolClass} tool (${toolName}) — proposers are read-only `
        + `(toolProfile:'propose' + permissionMode:'plan'). Lockout breach (#1075); the turn is aborted.`,
    );
    this.name = 'ProposerLockoutError';
    this.toolName = toolName;
    this.toolClass = toolClass;
  }
}

/**
 * Throw if a proposer event is a write or dispatch `tool_use`. Safe events
 * (text, thinking, read-only tools, tool_result, done, error) pass through.
 * The MoA engine calls this on every event a proposer emits.
 */
export function assertProposerEventAllowed(event: OrchestratorEvent, proposerLabel: string): void {
  if (event.type !== 'tool_use') return;
  const klass = classifyProposerTool(event.name);
  if (klass === 'safe') return;
  throw new ProposerLockoutError(event.name, klass, proposerLabel);
}
