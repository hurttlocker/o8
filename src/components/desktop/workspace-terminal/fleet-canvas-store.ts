/**
 * fleet-canvas-store — per-scope card position persistence for the
 * fleet-canvas tab.
 *
 * Key shape: `o8:fleet-canvas:pos:<scope>` → { [packetId]: { x, y } }.
 * Scope is the repo path the canvas tab is pinned to (or 'fleet' for the
 * unscoped fleet view) so an arrangement survives tab close/reopen and
 * app reloads. Follows the localStorage house pattern from
 * orchestrator-thread-restore.ts: window guard + try/catch everywhere.
 */

export interface FleetCardPosition {
  x: number;
  y: number;
}

export type FleetCanvasPositions = Record<string, FleetCardPosition>;

function storageKey(scope: string): string {
  return `o8:fleet-canvas:pos:${scope || 'fleet'}`;
}

export function readFleetCanvasPositions(scope: string): FleetCanvasPositions {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey(scope));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: FleetCanvasPositions = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value && typeof value === 'object'
        && typeof (value as FleetCardPosition).x === 'number'
        && typeof (value as FleetCardPosition).y === 'number'
        && Number.isFinite((value as FleetCardPosition).x)
        && Number.isFinite((value as FleetCardPosition).y)
      ) {
        result[id] = { x: (value as FleetCardPosition).x, y: (value as FleetCardPosition).y };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeFleetCanvasPosition(scope: string, packetId: string, position: FleetCardPosition): void {
  if (typeof window === 'undefined') return;
  try {
    const current = readFleetCanvasPositions(scope);
    current[packetId] = position;
    window.localStorage.setItem(storageKey(scope), JSON.stringify(current));
  } catch {
    // ignore — positions are a convenience, never load-bearing
  }
}
