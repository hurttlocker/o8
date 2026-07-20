import type { OrchestratorPacketRecovery } from '@/lib/orchestrator/types';
import type { LaneEvent } from './types';

export const RECOVERABLE_WORK_EVENT = 'recoverable_work_preserved';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function recoverableWorkMessage(
  preservedRef: string,
  preservedHeadSha: string | null,
  reviewed = false,
): string {
  const sha = preservedHeadSha ? ` (${preservedHeadSha.slice(0, 12)})` : '';
  const subject = reviewed ? 'Reviewed work' : 'Work';
  return `${subject} preserved at ${preservedRef}${sha} — retry or redispatch to resume.`;
}

export function normalizePacketRecovery(value: unknown): OrchestratorPacketRecovery | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<OrchestratorPacketRecovery>;
  const preservedRef = nonEmptyString(raw.preservedRef);
  const message = nonEmptyString(raw.message);
  if (!preservedRef || !message) return null;
  return {
    outcome: 'archived_recoverable',
    preservedRef,
    preservedHeadSha: nonEmptyString(raw.preservedHeadSha),
    message,
    recommendedAction: 'retry_packet',
  };
}

export function recoveryInfoFromLaneEvents(events: LaneEvent[]): OrchestratorPacketRecovery | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload ?? {};
    const eventName = nonEmptyString(payload.event);
    const preservedRef = nonEmptyString(payload.preservedRef) ?? nonEmptyString(payload.preservedBranch);
    if (!preservedRef || (eventName !== RECOVERABLE_WORK_EVENT && events[index]?.verb !== 'zombie_reap')) continue;
    const preservedHeadSha = nonEmptyString(payload.preservedHeadSha) ?? nonEmptyString(payload.preservedHead);
    const reviewed = payload.reviewed === true;
    return {
      outcome: 'archived_recoverable',
      preservedRef,
      preservedHeadSha,
      message: recoverableWorkMessage(preservedRef, preservedHeadSha, reviewed),
      recommendedAction: 'retry_packet',
    };
  }
  return null;
}
