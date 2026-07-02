/**
 * Read-only tool allowlist for the Brain composer ("Ask the Brain",
 * /api/panel/o8-scratch-chat). It is a read-oriented Q&A surface with no
 * approval-card round-trip, so it may ONLY run these repo-exploration tools.
 * Every mutating tool — run_terminal_command, write_file/edit_file/delete_file,
 * create_github_issue/create_pull_request, dispatch_codex_task, lane_command —
 * is refused there rather than executed ungated (SECURITY_AUDIT_2026-07-02
 * §HIGH-7). An allowlist (not the command denylist) so a "safe-looking" shell
 * command can't slip through.
 */
export const BRAIN_READ_ONLY_TOOLS = new Set<string>([
  'read_file',
  'list_files',
  'search_code',
  'read_github_issue_or_pr',
  'list_lanes',
  'search_web',
]);
