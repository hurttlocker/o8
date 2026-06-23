import 'server-only';

/**
 * Huddle mode resolution (#1282 / Huddle).
 *
 * Decides whether a dispatched worker does a bidirectional ALIGNMENT TURN
 * before it edits — i.e. whether `buildPacketPrompt` injects the huddle
 * instruction. Unlike Brain access, there's no operator-default mode: Huddle is
 * armed PER MISSION by the orchestrator, on exactly the packets it wants to
 * align on (ambiguous scope, risky/cross-cutting, novel). A clean typo-fix is
 * never armed, so it never pays the extra round-trip.
 *
 * The mechanism reuses existing plumbing: the worker posts its plan via
 * `o8 packet report --event huddle` (a blocking agent_report → lane flips to
 * `awaiting_orchestrator`), the orchestrator reviews it and steers the same
 * warm Codex thread (`steer_packet` → `codex exec resume`) ending in "proceed",
 * then the worker implements. One huddle per packet.
 */

export interface HuddleAccessInput {
  huddle?: boolean;
}

/** Production entry: Huddle is a pure per-packet flag (armed by the orchestrator). */
export function resolvePacketHuddleEnabled(packet: HuddleAccessInput): boolean {
  return packet.huddle === true;
}

/**
 * The prompt block injected when Huddle is armed. The worker aligns BEFORE it
 * edits — the objection is informed because it has already read the repo.
 */
export const HUDDLE_PROMPT_SECTION = [
  'Huddle mode (this packet): align with the orchestrator BEFORE you edit anything.',
  'First read the repo + this packet. If you have the Engineering Brain (`o8 ask`), consult it for relevant conventions, directives, or past fixes and fold that into your thinking — org memory is part of the huddle.',
  'Then post ONE report — `o8 packet report --event huddle --message "<your implementation plan, and flag any real ambiguity, a materially better approach, or a blocker that would waste this turn>"` — and STOP.',
  'The orchestrator will respond to align (confirm, refine, or accept your alternative). Implement ONLY after that response — and do this huddle exactly once, at the start, never again mid-task.',
  'If you have no real concern, still post your one-line plan so the orchestrator can confirm and you proceed.',
].join(' ');
