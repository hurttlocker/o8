/**
 * O8 panel focus event bus.
 *
 * The orchestrator chat tile renders write-class tool calls with a
 * "View in Workspace" button. Clicking it should pivot the right O8
 * panel to its Workspace/PRs tab — but only when that panel is
 * already open. We never auto-open it: forcing the right panel open
 * mid-conversation would feel intrusive.
 *
 * Rather than thread a callback through 5 levels of components, we
 * use a tiny publish/subscribe bus. The dashboard page subscribes on
 * mount, checks whether the O8 panel is open, and pivots its active
 * tab if so. If the panel is closed, the focus request is a no-op
 * (the original toast pathway was never wired to a renderer and was
 * removed).
 */

export type O8FocusTab = 'workspace' | 'prs' | 'browser' | 'activity' | 'inbox';

export interface O8FocusRequest {
  tab: O8FocusTab;
  /** File path, PR number, or other artifact id the target tab should focus. */
  artifactId?: string | null;
}

type FocusListener = (request: O8FocusRequest) => void;

const focusListeners = new Set<FocusListener>();

export function publishO8PanelFocus(request: O8FocusRequest): void {
  for (const listener of focusListeners) {
    try {
      listener(request);
    } catch (error) {
      console.warn('[o8-panel-focus] listener error', error);
    }
  }
}

export function subscribeO8PanelFocus(listener: FocusListener): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}
