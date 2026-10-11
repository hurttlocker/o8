export const MAX_RESIDENT_WORKSPACE_TABS = 3;

/** Keep the active tab plus the two most recently resident heavy surfaces. */
export function updateResidentTabIds(
  previous: string[],
  visibleTabIds: string[],
  activeTabId: string | null | undefined,
  limit = MAX_RESIDENT_WORKSPACE_TABS,
): string[] {
  const visible = new Set(visibleTabIds);
  const active = activeTabId && visible.has(activeTabId) ? activeTabId : null;
  const next = previous.filter((id) => visible.has(id) && id !== active);

  // Warm neighbors only on the first restore. Re-adding every offscreen tab
  // on each switch would evict the page the user just left, losing its state.
  if (previous.length === 0) {
    for (const id of visibleTabIds) {
      if (id === active || next.includes(id)) continue;
      next.push(id);
    }
  }
  if (active) next.push(active);

  return next.slice(-Math.max(1, limit));
}
