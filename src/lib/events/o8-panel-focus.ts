/**
 * O8 panel focus event bus.
 *
 * The orchestrator chat tile renders write-class tool calls with a
 * "View in Changes" button. Clicking it should pivot the right O8
 * panel to its Changes/Files/PRs tab — but only when that panel is
 * already open. We never auto-open it: forcing the right panel open
 * mid-conversation would feel intrusive.
 *
 * Rather than thread a callback through 5 levels of components, we
 * use a tiny publish/subscribe bus. The dashboard page subscribes on
 * mount, checks whether the O8 panel is open, and pivots its active
 * tab if so. If the panel is closed, the subscriber emits a
 * `togglePanelHint` the chat tile can render as a toast:
 * "Open right panel to view diff."
 */

export type O8FocusTab = 'changes' | 'files' | 'prs' | 'browser' | 'activity';

export interface O8FocusRequest {
  tab: O8FocusTab;
  /** File path, PR number, or other artifact id the target tab should focus. */
  artifactId?: string | null;
}

export interface O8FocusToast {
  message: string;
}

type FocusListener = (request: O8FocusRequest) => void;
type ToastListener = (toast: O8FocusToast) => void;

const focusListeners = new Set<FocusListener>();
const toastListeners = new Set<ToastListener>();

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

/**
 * Emit a user-facing hint that the O8 panel is closed. The dashboard
 * subscriber publishes this when a focus request comes in but the
 * panel isn't visible. The chat tile subscribes and renders a toast.
 */
export function publishO8PanelToast(toast: O8FocusToast): void {
  for (const listener of toastListeners) {
    try {
      listener(toast);
    } catch (error) {
      console.warn('[o8-panel-focus] toast listener error', error);
    }
  }
}

export function subscribeO8PanelToast(listener: ToastListener): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}
