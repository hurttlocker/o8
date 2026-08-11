import 'server-only';

import { ADVISOR_PROMPT_SECTION, resolvePacketAdvisorEnabled } from '@/lib/orchestrator/advisor-access';
import { HUDDLE_PROMPT_SECTION, resolvePacketHuddleEnabled, type HuddleAccessInput } from '@/lib/orchestrator/huddle-access';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

/**
 * Unified alignment resolution (#1513 hygiene pass).
 *
 * A worker does a plan-then-stop ALIGNMENT TURN before it edits when EITHER
 * source is armed:
 *   - `huddle` — the explicit per-mission flag the orchestrator sets on packets
 *     it wants to align on (`resolvePacketHuddleEnabled`).
 *   - `advisor` — the optional Adaptive start policy for single-subscription
 *     lower-cost workers (`resolvePacketAdvisorEnabled`).
 *
 * Both instruct "align before you edit", so exactly ONE prompt section is
 * emitted — the explicit huddle section wins; the advisor section only applies
 * when huddle is off. This is the single home for that OR + precedence, so
 * `packet-prompt` (which block to inject) and `huddle-zero-diff` (whether a
 * zero-diff exit was an EXPECTED alignment stop) can never drift apart. It
 * preserves the #1512 contracts exactly — see `packet-prompt-alignment.test.ts`
 * and `huddle-zero-diff.test.ts`.
 */
export interface PacketAlignment {
  /** True when either source arms the alignment turn. */
  armed: boolean;
  /** Which source armed it — huddle takes precedence over advisor. */
  source: 'huddle' | 'advisor' | null;
  /** The one prompt block to inject (huddle or advisor), or null when unarmed. */
  promptSection: string | null;
}

export type PacketAlignmentInput = HuddleAccessInput
  & Pick<OrchestratorPacket, 'runtime' | 'assignedModel' | 'workerRouting' | 'huddle'>;

export function resolvePacketAlignment(packet: PacketAlignmentInput): PacketAlignment {
  if (resolvePacketHuddleEnabled(packet)) {
    return { armed: true, source: 'huddle', promptSection: HUDDLE_PROMPT_SECTION };
  }
  if (resolvePacketAdvisorEnabled(packet)) {
    return { armed: true, source: 'advisor', promptSection: ADVISOR_PROMPT_SECTION };
  }
  return { armed: false, source: null, promptSection: null };
}
