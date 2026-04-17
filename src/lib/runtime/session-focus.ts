export const RUNTIME_SESSION_FOCUS_EVENT = 'cortex:focus-runtime-session';

export interface RuntimeSessionFocusDetail {
  sessionKey: string;
  repoPath?: string | null;
  label?: string | null;
}

export function requestRuntimeSessionFocus(detail: RuntimeSessionFocusDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<RuntimeSessionFocusDetail>(RUNTIME_SESSION_FOCUS_EVENT, {
    detail,
  }));
}
