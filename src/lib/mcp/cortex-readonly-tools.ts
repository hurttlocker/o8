/**
 * Cortex tools a read-only profile may call (Collide proposers, Solo turns).
 * The cortex server advertises and accepts only these under CORTEX_READONLY=1,
 * and the orchestrator prompt names only these on a read-only turn (#2898).
 * Allowlist, not denylist: a new cortex tool stays hidden until it opts in.
 */
export const CORTEX_READONLY_TOOLS: ReadonlySet<string> = new Set<string>([
  'cortex_ask',
  'cortex_read_packets',
  'cortex_read_transcript',
  'cortex_fleet_status',
  'cortex_list_approvals',
  'cortex_list_issues',
  'cortex_list_prs',
  'cortex_list_projects',
  'cortex_ci_status',
  'cortex_shared_team_status',
]);
