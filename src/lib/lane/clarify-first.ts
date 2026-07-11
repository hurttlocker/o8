/**
 * Clarify-first interview (#1489, reworked 2026-07-11).
 *
 * The interview doctrine (one question at a time, ordered by blast radius,
 * capped, escapable) lives in `orchestrator.md` and reaches every backend
 * through buildOrchestratorSystemPrompt. It arms on two SILENT triggers:
 *
 *   1. The request is dispatch-worthy AND materially ambiguous (standing
 *      doctrine — the model judges).
 *   2. The repo has no dispatch history in o8 yet (first mission) — the
 *      system-prompt builder detects this from the lanes table and injects
 *      the note built here via the {{CLARIFY_FIRST_RUN_NOTE}} template var.
 *
 * The old per-send composer toggle that PREPENDED a visible directive block
 * to the operator's message was removed (Q ruling 2026-07-11): the directive
 * leaked into the transcript bubble, and a governance behavior like this
 * belongs to o8 itself — silent, backend-agnostic — not to composer chrome.
 */

/** The heading resolved Q&A MUST be filed under in every brief/packet the
 *  orchestrator writes, so buildPacketPrompt carries it to workers. */
export const RESOLVED_UNKNOWNS_HEADING = 'Resolved unknowns';

/**
 * System-prompt note injected when the repo has no dispatch history yet.
 * Silent: lives in the system prompt, never in the transcript.
 */
export function buildFirstRunClarifyNote(): string {
  return [
    '**First mission on this repo.** o8 has no dispatch history for this repo yet,',
    'so you have no organizational memory to lean on. Treat the first',
    'dispatch-worthy request in this session as materially ambiguous by default:',
    'run the clarify-first interview before the first create_mission/dispatch,',
    'unless the operator explicitly skips ("skip, dispatch now") or the request',
    'is trivially scoped.',
  ].join(' ');
}
