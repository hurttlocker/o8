export interface ThoughtsChatPanelHandle {
  focusInput: () => void;
  reset: () => void;
  loadThread: (tabId: string) => void;
  /**
   * Fire a send with optional pre-fill. If `text` is provided, replaces
   * the input first then sends. Used by Orchestrator quick-action cards
   * that click-to-dispatch.
   */
  sendNow: (text?: string) => void;
}

export interface ThoughtsChatPanelChromeState {
  activeTargetLabel: string;
  waitingForReply: boolean;
  hasMessages: boolean;
  threadId: string | null;
}

export type ThoughtsChatPermissionMode = 'full' | 'plan';
