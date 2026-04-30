/**
 * Panel mode — derives whether the right-side workspace panel should
 * render the workspace-level Changes/Files/Git Log surface (idle) or
 * the packet-context Spec/Agent Overview surface (packet).
 *
 * Decision (epic #888 / issue #895): Option A — context-aware right
 * panel. When a packet is expanded in the orchestrator's mission rail,
 * the dashboard's right panel pivots to show that packet's Spec and
 * Agent Overview. When no packet is selected, the panel falls back to
 * the existing Changes/Files/Git Log workspace view.
 *
 * This module is the one place that owns that derivation so the
 * rendering paths in `dashboard/page.tsx` stay declarative — the
 * dashboard reads `derivePanelMode(...)` and switches on the result.
 */
export type PanelMode = 'idle' | 'packet';

export function derivePanelMode(input: { selectedPacketId: string | null | undefined }): PanelMode {
  return input.selectedPacketId ? 'packet' : 'idle';
}
