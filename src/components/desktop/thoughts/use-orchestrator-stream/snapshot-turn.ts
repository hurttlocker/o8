import type { OrchestratorSnapshotTurn } from './socket';

export function parseSnapshotTurn(value: unknown): OrchestratorSnapshotTurn | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const turn = value as Record<string, unknown>;
  if (typeof turn.id !== 'string' || typeof turn.startedAt !== 'number') return undefined;
  if (turn.settledAt !== null && typeof turn.settledAt !== 'number') return undefined;
  if (
    turn.outcome !== null
    && turn.outcome !== 'completed'
    && turn.outcome !== 'failed'
    && turn.outcome !== 'interrupted'
  ) return undefined;
  if (turn.assistantMessageId !== null && typeof turn.assistantMessageId !== 'string') return undefined;
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    settledAt: turn.settledAt,
    outcome: turn.outcome,
    assistantMessageId: turn.assistantMessageId,
  };
}

