import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({ socket: null as unknown }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'operator-fixture' }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', () => ({ openOrchestratorWebSocket: () => fixtures.socket }));
class Socket extends EventTarget {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(text: string) { const frame = JSON.parse(text); this.sent.push(frame);
    if (frame.type === 'symon-text-attach') queueMicrotask(() => this.receive({ channel: 'symon', type: 'symon-text-attached', sessionId: frame.sessionId, ok: true, transcript: [], turns: [] }));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  receive(frame: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}
beforeEach(() => { vi.resetModules(); vi.stubGlobal('WebSocket', { OPEN: 1 }); });
afterEach(() => vi.unstubAllGlobals());
describe('managed Symon adapter', () => {
  it('keeps the configured text session through voice reconnections and awaits terminal receipts', async () => {
    const socket = new Socket(); fixtures.socket = socket;
    const fetch = vi.fn(async () => Response.json({ session: { sessionId: 'symon-existing', engine: 'claude', model: 'configured-model' } }));
    vi.stubGlobal('fetch', fetch);
    const { getManagedSymonBackend, subscribeManagedSymonConfirmation } = await import('./symon-backend');
    const pending = getManagedSymonBackend();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    socket.dispatchEvent(new Event('open'));
    const backend = await pending;
    const update = vi.fn(async () => {});
    const turn = backend.delegate('Check this', 'delegation-one', update);
    expect(socket.sent.find(frame => frame.type === 'symon-text-turn')).toEqual({ channel: 'symon', type: 'symon-text-turn', sessionId: 'symon-existing', turnId: 'delegation-one', text: 'Check this' });
    socket.receive({ channel: 'symon', type: 'symon-text-delta', sessionId: 'symon-existing', turnId: 'delegation-one', delta: 'Verified result' });
    expect(update).not.toHaveBeenCalled();
    const confirmations = vi.fn(); const unsubscribe = subscribeManagedSymonConfirmation(confirmations);
    socket.receive({ channel: 'symon', type: 'symon-confirm-required', sessionId: 'symon-existing', callId: 'delegation-one', confirmationId: 'approval-1', tool: 'shell', summary: 'Run requested command', expiresAt: Date.now() + 60_000 });
    const approval = confirmations.mock.calls.at(-1)![0];
    expect(approval.callId).toBe('delegation-one');
    approval.decide(false);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'symon-confirm-decision', callId: 'delegation-one', confirmationId: 'approval-1', allow: false });
    unsubscribe();
    socket.receive({ channel: 'symon', type: 'symon-text-done', sessionId: 'symon-existing', turnId: 'delegation-one', status: 'done' });
    await turn;
    expect(update).toHaveBeenCalledWith('Verified result');
    expect(await getManagedSymonBackend()).toBe(backend);
    expect(backend.context()).toContain('Verified result');
    expect(fetch).toHaveBeenCalledTimes(1);
    const second = backend.delegate('Keep working', 'delegation-two', update);
    await backend.delegate('stop', 'stop-request', update);
    expect(socket.sent.at(-1)?.type).toBe('symon-text-interrupt');
    expect(update).toHaveBeenLastCalledWith('Stop requested. Waiting for backend confirmation.');
    socket.receive({ channel: 'symon', type: 'symon-text-done', sessionId: 'symon-existing', turnId: 'delegation-two', status: 'interrupted' });
    await second;
    expect(update).toHaveBeenLastCalledWith('The backend confirmed this task was interrupted.');
    socket.readyState = 3;
    const reattached = new Socket(); fixtures.socket = reattached;
    await backend.ready!();
    expect(reattached.sent[0]).toMatchObject({ type: 'symon-text-attach', sessionId: 'symon-existing' });
    expect(fetch).toHaveBeenCalledTimes(1);
    socket.dispatchEvent(new Event('close')); reattached.readyState = 3; reattached.dispatchEvent(new Event('close'));
  });
});

it('removes CONNECTING startup listeners and owns only one heartbeat across reconnect', async () => {
  vi.useFakeTimers();
  try {
    const first = new Socket(); first.readyState = 0; fixtures.socket = first;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ session: { sessionId: 's', engine: 'claude', model: 'm' } })));
    const { getManagedSymonBackend } = await import('./symon-backend');
    const pending = getManagedSymonBackend();
    await vi.advanceTimersByTimeAsync(0); first.readyState = 1; first.dispatchEvent(new Event('open'));
    const backend = await pending;
    first.dispatchEvent(new Event('error'));
    expect(first.readyState).toBe(1);
    first.close();
    const second = new Socket(); fixtures.socket = second;
    await backend.ready!(); const before = second.sent.length;
    first.dispatchEvent(new Event('close'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(second.sent.length - before).toBe(1);
    second.close(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
