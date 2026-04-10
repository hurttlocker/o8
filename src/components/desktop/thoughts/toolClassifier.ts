/**
 * Tool-call side-effect classifier.
 *
 * Decides how a tool call should render in the orchestrator chat based
 * on what the tool actually does. Three buckets:
 *
 *   read   — inspection only. No state changes, no outbound messages,
 *            no fleet movement. Safe to run in plan mode without any
 *            user confirmation.
 *   write  — mutates something. File edits, mission dispatch, approval
 *            resolution, side-effecting shell commands. These are what
 *            plan mode will gate.
 *   meta   — ambient status pings. Fleet status, health checks, etc.
 *            Neither modifies nor inspects user-facing state — just
 *            telemetry the orchestrator uses to decide what to do.
 *
 * The classifier is conservative: when in doubt, tools are treated as
 * `write` so the bordered card + amber accent shows up. Better to flag
 * an inspection as potentially destructive than the other way around.
 */

import type { ToolSideEffectClass } from '@/lib/mobile/types';

// ── Allowlists (normalized to lowercase) ──

const READ_NAMES = new Set<string>([
  // Claude Code built-ins
  'read',
  'read_file',
  'grep',
  'glob',
  'list_files',
  'ls',
  'notebookread',
  'notebook_read',
  'todoread',
  'todo_read',
  // Cortex MCP inspection tools
  'cortex_list_issues',
  'cortex_list_prs',
  'cortex_list_approvals',
  'cortex_read_packets',
  'cortex_read_transcript',
  'cortex_ci_status',
  'cortex_list_agents',
  // Operator MCP inspection tools
  'o8_status',
  'o8_history',
  'get_mission_status',
  // Web / content inspection
  'web_search',
  'search_web',
  'web_fetch',
  'fetch_url',
  'memory_search',
  'cortex_search',
]);

const WRITE_NAMES = new Set<string>([
  // Claude Code built-ins
  'write',
  'write_file',
  'edit',
  'edit_file',
  'notebookedit',
  'notebook_edit',
  'todowrite',
  'todo_write',
  // Cortex MCP mutation tools
  'cortex_launch_agent',
  'cortex_steer_agent',
  'cortex_interrupt_agent',
  'cortex_update_packet',
  'cortex_resolve_approval',
  // Operator MCP mutation tools
  'create_mission',
  'dispatch_mission',
  'approve_and_merge',
  'submit_review',
  'reset_packet',
  'retry_packet',
  'o8_send',
  'o8_approve',
  'o8_reject',
  // Image generation counts as a write (produces artifacts)
  'image',
]);

const META_NAMES = new Set<string>([
  'cortex_fleet_status',
  'cortex_fleet_snapshot',
  'cortex_health',
]);

// Read-only shell commands. Anything whose first token is in this list
// is treated as a read regardless of flags. Conservative — if the user
// chains a write (`ls && rm`), we fall through to `write`.
const READ_ONLY_SHELL_COMMANDS = new Set<string>([
  'ls',
  'cat',
  'head',
  'tail',
  'pwd',
  'whoami',
  'date',
  'echo',
  'grep',
  'rg',
  'find',
  'fd',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'wc',
  'sort',
  'uniq',
  'tree',
  'env',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set<string>([
  'status',
  'log',
  'show',
  'diff',
  'blame',
  'branch',
  'remote',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'describe',
  'config',
  'reflog',
  'stash',
]);

// ── Helpers ──

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

function classifyShellCommand(command: string): ToolSideEffectClass {
  const trimmed = command.trim();
  if (!trimmed) return 'write';

  // Chaining/piping makes intent hard to read statically — if anywhere
  // in the string there's a pipe to a write, we can't easily tell.
  // Conservative: single-command read-only, otherwise write.
  if (/[;&|><]/.test(trimmed)) {
    // Allow simple pipes between read-only utilities (e.g. `cat x | grep y`).
    const segments = trimmed.split(/\|/).map((s) => s.trim());
    if (segments.length > 1 && segments.every(isStrictReadOnlySegment)) {
      return 'read';
    }
    return 'write';
  }

  return isStrictReadOnlySegment(trimmed) ? 'read' : 'write';
}

function isStrictReadOnlySegment(segment: string): boolean {
  const token = firstToken(segment);
  if (!token) return false;
  if (READ_ONLY_SHELL_COMMANDS.has(token)) return true;
  if (token === 'git') {
    const sub = segment.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
    return READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  return false;
}

function readArgString(args: Record<string, unknown> | undefined, keys: string[]): string | null {
  if (!args) return null;
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ── Public API ──

export function classifyToolCall(
  name: string,
  args?: Record<string, unknown>,
): ToolSideEffectClass {
  const normalized = name.toLowerCase();

  if (READ_NAMES.has(normalized)) return 'read';
  if (WRITE_NAMES.has(normalized)) return 'write';
  if (META_NAMES.has(normalized)) return 'meta';

  // Shell exec variants need to inspect the actual command to decide.
  if (normalized === 'exec' || normalized === 'exec_command' || normalized === 'bash' || normalized === 'shell') {
    const command = readArgString(args, ['command', 'cmd', 'shell']);
    if (command) return classifyShellCommand(command);
    return 'write';
  }

  // Browser tools fall into write because they navigate / mutate page state.
  if (normalized === 'browser' || normalized === 'navigate' || normalized.startsWith('browser_')) {
    return 'write';
  }

  // Unknown tool names — conservative default. An unknown read will
  // render as a card (overkill but safe); an unknown write as a chip
  // would hide real side effects (dangerous).
  return 'write';
}

/**
 * Does this write-class tool target a file the O8 panel can display?
 * Only file-edit tools get the "View in Changes" affordance.
 */
export function writeTargetsFile(name: string, args?: Record<string, unknown>): string | null {
  const normalized = name.toLowerCase();
  if (
    normalized === 'edit'
    || normalized === 'edit_file'
    || normalized === 'write'
    || normalized === 'write_file'
    || normalized === 'notebookedit'
    || normalized === 'notebook_edit'
  ) {
    return readArgString(args, ['file_path', 'path', 'notebook_path']);
  }
  return null;
}
