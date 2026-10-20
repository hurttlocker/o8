import { expect, it } from 'vitest';
import { attachSymonTextSession, type AttachableSymonTurn } from './symon-text-attachment';
import type { SymonTextSessionRecord } from './symon-text-session-store';
function fixture() {
  const record = { sessionId: 'session', subject: 'device', deviceId: 'phone-a', reattachable: true, transcript: [], pendingTurnIds: ['turn'] } as unknown as SymonTextSessionRecord;
  const turns = new Map<string, AttachableSymonTurn>([['turn', { sessionId: 'session', turnId: 'turn', clientId: 'old', terminal: false }]]);
  return { record, turns, sessionId: 'session', owners: new Map([['session', 'old']]), connected: () => false,
    client: { id: 'new', authKind: 'device', deviceId: 'phone-a' } };
}
it('reattaches the same pending turn without replay and rejects another principal', () => {
  const f = fixture(); expect(attachSymonTextSession({ ...f, client: { ...f.client, deviceId: 'phone-b' } }).ok).toBe(false);
  expect(f.turns.get('turn')!.clientId).toBe('old');
  expect(attachSymonTextSession(f)).toMatchObject({ ok: true, turns: [{ turnId: 'turn', status: 'running' }] });
  expect(f.turns.size).toBe(1); expect(f.turns.get('turn')!.clientId).toBe('new');
  expect(attachSymonTextSession(f).ok).toBe(true); expect(f.turns.size).toBe(1);
});
it('does not take over a connected owner or invent recovery after a backend restart', () => {
  const f = fixture(); expect(attachSymonTextSession({ ...f, connected: () => true })).toMatchObject({ error: 'session_attached_elsewhere' });
  f.turns.clear(); expect(attachSymonTextSession(f)).toMatchObject({ error: 'backend_restart_unconfirmed' });
  expect(attachSymonTextSession({ ...f, record: null }).ok).toBe(false);
});
it('replays durable final receipts after in-memory turn eviction without dispatch', () => {
  const f = fixture(); f.turns.clear(); f.record.pendingTurnIds = [];
  f.record.completedTurns = [{ turnId: 'turn', status: 'done', text: 'Verified answer' }];
  expect(attachSymonTextSession(f)).toMatchObject({ ok: true, turns: [{ turnId: 'turn', status: 'done', text: 'Verified answer' }] });
});
