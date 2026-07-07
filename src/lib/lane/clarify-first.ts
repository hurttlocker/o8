/**
 * Clarify-first interview directive (#1489).
 *
 * A per-send composer affordance ("Clarify first") prepends this directive block
 * to the operator's message. It instructs the orchestrator to run an interview —
 * one question at a time, ordered by architectural blast radius — BEFORE it
 * writes any brief or calls create_mission/dispatch, then fold the resolved Q&A
 * into the briefs it writes so workers inherit the answers.
 *
 * The block is a pure string prefix so the toggle stays zero-friction: off →
 * the outgoing message is byte-identical to today; on → the directive leads and
 * the operator's own text follows verbatim. The transcript still shows only the
 * operator's text (the send path passes it as `displayMessage`).
 *
 * The standing doctrine that governs HOW the interview runs lives in
 * `orchestrator.md` (see buildOrchestratorSystemPrompt) — this block is the
 * per-turn trigger that also fires when the operator wants it on an otherwise
 * unambiguous prompt.
 */

/** Heading that opens the directive block; also the assertion anchor in tests. */
export const CLARIFY_DIRECTIVE_HEADING = '[CLARIFY-FIRST DIRECTIVE]';

/** The heading resolved Q&A MUST be filed under in every brief/packet the
 *  orchestrator writes, so buildPacketPrompt carries it to workers. */
export const RESOLVED_UNKNOWNS_HEADING = 'Resolved unknowns';

/** Build the clarify-first directive block (no trailing operator message). */
export function buildClarifyDirectiveBlock(): string {
  return [
    CLARIFY_DIRECTIVE_HEADING,
    'Before you create_mission, dispatch, or write ANY brief for the request below, run the clarify-first interview:',
    '- Surface the unknowns that would change the architecture, and ask the operator to resolve them ONE question at a time.',
    '- Order the questions by blast radius: data model > type/interface contracts > UX flow > mechanical detail. Ask the highest-blast-radius unknown first.',
    '- Ask at most ~5 questions, and stop as soon as the only unknowns left are mechanical detail.',
    '- The operator may reply "skip, dispatch now" at any point — honor it immediately and proceed with what you have.',
    `- When the interview resolves (or is skipped), embed the resolved Q&A under a "${RESOLVED_UNKNOWNS_HEADING}" heading in every mission/packet description you write, so the workers inherit the answers. Then proceed.`,
    'Do not dispatch before the interview is resolved or explicitly skipped.',
    `[END ${CLARIFY_DIRECTIVE_HEADING.slice(1)}`,
  ].join('\n');
}

/**
 * Prepend the clarify-first directive to an operator message. Returns the block
 * followed by a blank line and the original message verbatim.
 */
export function prependClarifyDirective(message: string): string {
  return `${buildClarifyDirectiveBlock()}\n\n${message}`;
}
