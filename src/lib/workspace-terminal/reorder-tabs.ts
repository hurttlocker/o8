/** Place a tab relative to an anchor without changing its identity or contents. */
export function reorderTabs<T extends { id: string }>(tabs: T[], sourceId: string, targetId: string, after?: boolean): T[] {
  const from = tabs.findIndex(tab => tab.id === sourceId);
  const target = tabs.findIndex(tab => tab.id === targetId);
  if (from < 0 || target < 0 || from === target) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  next.splice(next.findIndex(tab => tab.id === targetId) + Number(after ?? from < target), 0, moved);
  return next;
}
