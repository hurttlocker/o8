/**
 * Reviewer availability is a scheduling condition, not a packet failure.
 *
 * Keep the legacy text classifier narrow because pre-v46 queue rows only have
 * `last_error` to describe why they exhausted. New turns carry the structured
 * `session_busy` reason instead.
 */

export type ReviewUnavailableReason = 'session_busy';

export function isReviewerSessionBusyMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /\b(?:codex|claude(?: code)?|orchestrator|reviewer)\s+(?:orchestrator\s+)?session\s+(?:is\s+)?busy\b/i
    .test(value.trim());
}

