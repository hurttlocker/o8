export type TerminalDiagnostic = {
  code: 'terminal_client_hidden_overflow'
    | 'terminal_hidden_overflow'
    | 'terminal_resync_failed'
    | 'terminal_resync_unsettled';
  sessionName: string;
  clientId?: string;
  bytesDropped?: number;
  lastGoodOffset?: number;
  reason?: string;
  retainedBytes?: number;
  waitedMs?: number;
  timestamp: string;
};

declare global {
  interface Window {
    __o8TerminalDiagnostics?: TerminalDiagnostic[];
  }
}

const MAX_RETAINED_DIAGNOSTICS = 100;

export function recordTerminalDiagnostic(diagnostic: Omit<TerminalDiagnostic, 'timestamp'>): void {
  if (typeof window === 'undefined') return;
  const entry: TerminalDiagnostic = { ...diagnostic, timestamp: new Date().toISOString() };
  const diagnostics = window.__o8TerminalDiagnostics ?? [];
  diagnostics.push(entry);
  if (diagnostics.length > MAX_RETAINED_DIAGNOSTICS) {
    diagnostics.splice(0, diagnostics.length - MAX_RETAINED_DIAGNOSTICS);
  }
  window.__o8TerminalDiagnostics = diagnostics;
  window.dispatchEvent(new CustomEvent('o8:terminal-diagnostic', { detail: entry }));
}
