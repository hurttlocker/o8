export type ComposerWireMode = 'solo' | 'multitask' | 'moa';

/**
 * Dispatch is an MCP tool on the `cortex` server, and every orchestrator backend
 * namespaces it differently in the model's tool list (Claude:
 * `mcp__cortex__cortex_launch_agent`, Codex: `cortex__cortex_launch_agent` /
 * `cortex.cortex_launch_agent`). The bare registered name is the one form that
 * is correct everywhere, it is the suffix of all the namespaced forms, and it is
 * what `orchestrator.md` already uses in the system prompt — so the directives
 * name it that way too (#2153).
 */
const LAUNCH_TOOL_NAME = 'cortex_launch_agent';

const DISPATCH_IMPERATIVE = `Dispatch means calling the \`${LAUNCH_TOOL_NAME}\` tool — call it once per packet, in parallel, in this turn, BEFORE you write any summary. A turn with no \`${LAUNCH_TOOL_NAME}\` call has dispatched nothing, however good the plan is; never claim work was dispatched without the tool results to show for it. Review and merge through the gate as they finish.`;

export const COMPOSER_MODE_DIRECTIVES: Readonly<Record<ComposerWireMode, string>> = {
  solo: '[Mode: Solo] Work directly in this session yourself — do NOT dispatch worker agents or create missions. Edit, run, and verify with your own tools.',
  multitask: `[Mode: Multitask] Decompose this into parallel worker packets and dispatch them into isolated worktrees instead of working serially yourself. ${DISPATCH_IMPERATIVE}`,
  moa: `[Mode: Mixture of Agents] After the proposal round, decompose the work into parallel worker packets and dispatch them into isolated worktrees. ${DISPATCH_IMPERATIVE}`,
};

/**
 * Directive strings o8 shipped before #2153. A client running an older build
 * still sends them, and history written by one still holds them, so the
 * persistence boundary keeps recognizing them — otherwise the operator's own
 * words get stored with a stale directive glued to the front.
 */
const LEGACY_COMPOSER_MODE_DIRECTIVES: readonly string[] = [
  '[Mode: Multitask] Decompose this into parallel worker packets and dispatch them into isolated worktrees instead of working serially yourself. Review and merge through the gate as they finish.',
  '[Mode: Mixture of Agents] After the proposal round, decompose the work into parallel worker packets and dispatch them into isolated worktrees. Review and merge through the gate as they finish.',
];

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
  const directives = [
    ...Object.values(COMPOSER_MODE_DIRECTIVES),
    ...LEGACY_COMPOSER_MODE_DIRECTIVES,
  ];
  for (const directive of directives) {
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
