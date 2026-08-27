/**
 * Quick actions surfaced by the Cmd+K palette inside the Orchestrator tab.
 *
 * Pure module — no React imports. The palette renders these and, on pick,
 * fills the composer with `promptTemplate` (operator can edit before
 * sending). Do NOT auto-send from here.
 *
 * Keep the list short and verb-led. If we need more than ~8 items we
 * should rethink the surface.
 */

export interface QuickAction {
  id: string;
  verb: string;
  label: string;
  promptTemplate: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'prompts',
    verb: 'Prompts',
    label: 'Insert a saved prompt',
    promptTemplate: '',
  },
  {
    id: 'dispatch',
    verb: 'Dispatch',
    label: 'Dispatch the next packet',
    promptTemplate: 'Dispatch the next open packet. Show me the packet plan first, then launch.',
  },
  {
    id: 'decompose',
    verb: 'Decompose',
    label: 'Break a big issue into packets',
    promptTemplate: 'Decompose the following issue into merge-ready packets, each scoped to a single file or subsystem:\n\n',
  },
  {
    id: 'fix',
    verb: 'Fix',
    label: 'File and dispatch a bug fix',
    promptTemplate: 'File a bug issue and dispatch a fix packet for the following problem:\n\n',
  },
  {
    id: 'review',
    verb: 'Review',
    label: 'Review the latest open PR',
    promptTemplate: 'Review the latest open PR against main. Flag rule violations, bugs, or missing tests before approving.',
  },
  {
    id: 'status',
    verb: 'Status',
    label: "Show me what's running",
    promptTemplate: 'Give me a snapshot of every active packet, lane, and agent session across the fleet.',
  },
  {
    id: 'clear',
    verb: 'Clear',
    label: 'Start a fresh thread',
    promptTemplate: '/clear',
  },
];

/**
 * Substring-match filter on verb + label. Empty query returns the full list.
 */
export function filterQuickActions(query: string, actions: QuickAction[] = QUICK_ACTIONS): QuickAction[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return actions;
  return actions.filter((action) => {
    const haystack = `${action.verb} ${action.label}`.toLowerCase();
    return haystack.includes(trimmed);
  });
}
