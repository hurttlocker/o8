/**
 * Repository and project inventory changes made through the server (an MCP
 * command, the CLI, another window) reach the open window as one realtime
 * mutation tag (#3559). Client-safe: no server imports.
 */
export const REPO_INVENTORY_RUNTIME = 'repo-registry';

/** True when an `o8:realtime` event detail carries an inventory change. */
export function hasRepoInventoryChange(detail: unknown): boolean {
  const events = (detail as { data?: { events?: unknown } } | null)?.data?.events;
  if (!Array.isArray(events)) return false;
  return events.some((event) => (event as { data?: { mutation?: { runtime?: unknown } } } | null)
    ?.data?.mutation?.runtime === REPO_INVENTORY_RUNTIME);
}
