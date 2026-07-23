export type ComposerWireMode = 'solo' | 'multitask' | 'moa';

export const COMPOSER_MODE_DIRECTIVES: Readonly<Record<ComposerWireMode, string>> = {
  solo: '[Mode: Solo] Work directly in this session yourself — do NOT dispatch worker agents or create missions. Edit, run, and verify with your own tools.',
  multitask: '[Mode: Multitask] Decompose this into parallel worker packets and dispatch them into isolated worktrees instead of working serially yourself. Review and merge through the gate as they finish.',
  moa: '[Mode: Mixture of Agents] After the proposal round, decompose the work into parallel worker packets and dispatch them into isolated worktrees. Review and merge through the gate as they finish.',
};

export interface ComposerWireMessage {
  /** Operator-authored text used by transcripts, history, and thread titles. */
  displayMessage: string;
  /** Model-facing text with the selected mode directive attached. */
  wireMessage: string;
}

export function composeComposerWireMessage(
  message: string,
  mode: ComposerWireMode,
): ComposerWireMessage {
  if (message.startsWith('/')) {
    return { displayMessage: message, wireMessage: message };
  }
  return {
    displayMessage: message,
    wireMessage: `${COMPOSER_MODE_DIRECTIVES[mode]}\n\n${message}`,
  };
}

/**
 * Legacy clients may omit displayMessage. Remove only exact preambles emitted
 * by o8 so the persistence boundary still stores the operator's own words.
 */
export function stripKnownComposerWirePreamble(message: string): string {
  for (const directive of Object.values(COMPOSER_MODE_DIRECTIVES)) {
    const prefix = `${directive}\n\n`;
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return message;
}

export function isKnownComposerPreambleTitle(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const title = value.trim();
  return Object.values(COMPOSER_MODE_DIRECTIVES).some((directive) => {
    const markerEnd = directive.indexOf(']');
    if (markerEnd < 0) return false;
    const marker = directive.slice(0, markerEnd + 1);
    return title.startsWith(marker) || title.startsWith(marker.slice(1, -1));
  });
}

export function resolveOrchestratorTranscriptMessage(input: {
  message: string;
  displayMessage?: unknown;
}): string {
  if (typeof input.displayMessage === 'string' && input.displayMessage.trim()) {
    return input.displayMessage;
  }
  return stripKnownComposerWirePreamble(input.message);
}
