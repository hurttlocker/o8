export interface TerminalExitState {
  exitCode: number | null;
  /** Bounded plain text from the terminal buffer, never executable markup. */
  transcript: string;
}

export const MAX_EXIT_TRANSCRIPT_CHARS = 128 * 1024;

export function terminalExitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function terminalProcessExitCode(value: unknown, source: unknown): number | null {
  // A tmux attachment reports its client's status, not the shell's status.
  return source === 'process' ? terminalExitCode(value) : null;
}

export function terminalExitState(exitCode: unknown, transcript = ''): TerminalExitState {
  return {
    exitCode: terminalExitCode(exitCode),
    transcript: transcript.slice(-MAX_EXIT_TRANSCRIPT_CHARS),
  };
}

export function parseTerminalExitState(value: unknown): TerminalExitState | undefined {
  if (!value || typeof value !== 'object' || !('transcript' in value) || typeof value.transcript !== 'string') return undefined;
  return terminalExitState('exitCode' in value ? value.exitCode : undefined, value.transcript);
}
