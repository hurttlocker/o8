import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LiveTranscript, startManagedLive } from './session';
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'operator-fixture' }));
class Peer {
  localDescription = { sdp: 'v=0\nfixture-offer' };
  connectionState = 'connected';
  ontrack = null; onconnectionstatechange = null;
  addTrack = vi.fn(); createDataChannel = vi.fn(); close = vi.fn();
  createOffer = async () => this.localDescription;
  setLocalDescription = async () => {};
  setRemoteDescription = async () => {};
}
class AudioFixture { srcObject = null; play = async () => {}; pause = vi.fn(); }
class AudioContextFixture {
  close = async () => {};
  createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }; }
  createMediaStreamSource() { return { connect() {} }; }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
describe('managed Live transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('Audio', AudioFixture); vi.stubGlobal('AudioContext', AudioContextFixture);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) } });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('does not create a paid session when startup is canceled during microphone permission', async () => {
    let resolveMic!: (value: unknown) => void;
    const stopped = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveMic = resolve; }) } });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const starting = startManagedLive({ binding: 'a', context: () => '', delegate: vi.fn() }, () => {}, controller.signal);
    const rejection = expect(starting).rejects.toThrow();
    await flush(); controller.abort();
    resolveMic({ getTracks: () => [{ stop: stopped }] });
    await rejection;
    expect(fetch).not.toHaveBeenCalled(); expect(stopped).toHaveBeenCalledOnce();
  });
  it('never transitions live or dispatches when peer failure closes during answer installation', async () => {
    class FailingPeer extends Peer {
      setRemoteDescription = async () => { this.connectionState = 'failed'; (this.onconnectionstatechange as unknown as (() => void))?.(); };
    }
    vi.stubGlobal('RTCPeerConnection', FailingPeer);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'start') return Response.json({ id: 'failed-start', sdp: 'answer' });
      return Response.json({ events: [{ cursor: 1, event: { type: 'session.closed', usage: { seconds: 15 } } }] });
    }));
    const delegate = vi.fn(); const states: string[] = [];
    await startManagedLive({ binding: 'a', context: () => '', delegate }, state => states.push(state));
    await flush();
    expect(states).not.toContain('live'); expect(delegate).not.toHaveBeenCalled();
  });
  it('preserves exact transcript fragments and deduplicates delegation events', () => {
    const t = new LiveTranscript();
    t.observe({ type: 'session.input_transcript.delta', event_id: '1', delta: 'Check ', start_ms: 0, end_ms: 10 });
    t.observe({ type: 'session.input_transcript.delta', event_id: '2', delta: 'the task', start_ms: 10, end_ms: 20 });
    const event = { type: 'session.delegation.created', event_id: '3', offset_ms: 30, delegation: { id: 'd1', target: 'client' } };
    expect(t.observe(event)).toEqual({ id: 'd1', text: 'Check the task' });
    expect(t.observe(event)).toBeNull();
    expect(t.observe({ ...event, event_id: '4' })).toBeNull();
  });
  it('closes after real inactivity, waits for terminal usage, and retains backend work', async () => {
    let closed = false;
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (body.action === 'start') return Response.json({ id: 'fixture-session', sdp: 'v=0\nanswer' });
      if (body.action === 'close') { closed = true; return Response.json({ state: 'closing' }); }
      return Response.json({ events: closed ? [{ cursor: 1, event: { type: 'session.closed', usage: { seconds: 60 } } }] : [] });
    }));
    const backend = { binding: 'repo:thread:claude', context: () => 'Existing conversation', delegate: vi.fn() };
    const states: string[] = [];
    const live = await startManagedLive(backend, state => states.push(state));
    await vi.advanceTimersByTimeAsync(59_800); expect(live.state).toBe('live');
    await vi.advanceTimersByTimeAsync(500); expect(live.state).toBe('closed');
    expect(states).toContain('closing');
    expect(requests.filter(r => r.action === 'start')).toHaveLength(1);
    expect(requests.every(r => r.binding === backend.binding)).toBe(true);
    expect(backend.delegate).not.toHaveBeenCalled();
  });
  it('keeps closure unconfirmed without a terminal receipt, never auto reconnects', async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      return Response.json(body.action === 'start' ? { id: 'fixture', sdp: 'v=0\nanswer' } : { events: [] });
    }));
    const live = await startManagedLive({ binding: 'thread', context: () => '', delegate: vi.fn() }, () => {});
    const closing = live.close(); await flush(); expect(live.state).toBe('closing');
    await vi.advanceTimersByTimeAsync(15_000); await closing;
    expect(live.state).toBe('unknown');
    expect(requests.filter(r => r.action === 'start')).toHaveLength(1);
  });
});
