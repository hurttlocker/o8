import type { SymonTextSessionRecord } from './symon-text-session-store';
export interface SymonTextAttachmentClient { id: string; authKind: string; deviceId?: string | null }
export interface AttachableSymonTurn { clientId: string; sessionId: string; turnId: string; terminal: boolean; resultStatus?: string; resultText?: string }
/** A transport reattachment never executes or replays a turn. */
export function attachSymonTextSession(input: {
  sessionId: string; client: SymonTextAttachmentClient; record: SymonTextSessionRecord | null;
  owners: Map<string, string>; turns: Map<string, AttachableSymonTurn>;
  connected: (clientId: string) => boolean;
}) {
  const { record, client, sessionId, owners, turns } = input;
  if (!record?.reattachable || record.subject !== client.authKind
    || (record.subject !== 'operator' && record.deviceId !== client.deviceId)) return { ok: false as const, error: 'session_unavailable' };
  const previous = owners.get(sessionId);
  if (previous && previous !== client.id && input.connected(previous)) return { ok: false as const, error: 'session_attached_elsewhere' };
  const matching = [...turns.values()].filter(turn => turn.sessionId === sessionId);
  if (record.pendingTurnIds?.some(id => !matching.some(turn => turn.turnId === id))) {
    return { ok: false as const, error: 'backend_restart_unconfirmed' };
  }
  owners.set(sessionId, client.id);
  for (const turn of matching) turn.clientId = client.id;
  const receipts = (record.completedTurns ?? []).filter(receipt => !matching.some(turn => turn.turnId === receipt.turnId));
  return { ok: true as const, transcript: record.transcript, turns: [...receipts, ...matching.map(turn => ({
    turnId: turn.turnId, status: turn.terminal ? turn.resultStatus ?? 'failed' : 'running', text: turn.resultText ?? '',
  }))] };
}
