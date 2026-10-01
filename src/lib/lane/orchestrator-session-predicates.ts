/** ExitPlanMode / can_use_tool / control_request must never escalate a plan turn. */
const PERMISSION_TOOL_NAMES = new Set(['ExitPlanMode', 'exit_plan_mode', 'permission_request', 'request_permission']);

export function detectPermissionRequest(raw: Record<string, unknown>): boolean {
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (type === 'can_use_tool' || type === 'control_request' || type === 'permission_request') return true;
  const bareName = typeof raw.name === 'string' ? raw.name
    : typeof raw.tool_name === 'string' ? raw.tool_name
      : typeof raw.tool === 'string' ? raw.tool : '';
  if (bareName && PERMISSION_TOOL_NAMES.has(bareName)) return true;
  const block = raw.content_block as Record<string, unknown> | undefined;
  if (block && block.type === 'tool_use' && typeof block.name === 'string' && PERMISSION_TOOL_NAMES.has(block.name)) return true;
  const content = (raw.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      const bb = b as Record<string, unknown> | null;
      if (bb && bb.type === 'tool_use' && typeof bb.name === 'string' && PERMISSION_TOOL_NAMES.has(bb.name)) return true;
    }
  }
  return false;
}

/** Exact stream-json failure observed with Claude Code 2.1.284 and an absent resume ID. */
export function missingClaudeResumeError(raw: Record<string, unknown>, sessionId: string | null): string | null {
  if (!sessionId || raw.type !== 'result' || raw.is_error !== true || raw.session_id !== sessionId) return null;
  const message = `No conversation found with session ID: ${sessionId}`;
  return Array.isArray(raw.errors) && raw.errors.includes(message) ? message : null;
}
