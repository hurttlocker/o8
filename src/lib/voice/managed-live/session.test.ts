import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LiveConversationBridge } from './conversation-bridge';
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
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('uses real local capture lifecycle in development preview without a remote peer or delegation', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const remote = vi.fn(); const peerClose = vi.fn(); const stopped = vi.fn();
    class PreviewPeer extends Peer { setRemoteDescription = remote; close = peerClose; }
    vi.stubGlobal('RTCPeerConnection', PreviewPeer);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopped }] }) } });
    let terminal = false;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'start') return Response.json({ id: 'preview', transport: 'local-preview' });
      if (body.action === 'close') terminal = true;
      return Response.json({ events: terminal ? [{ cursor: 1, event: { type: 'session.closed' } }] : [] });
    }));
    const delegate = vi.fn(); const changed = vi.fn();
    const live = await startManagedLive({ binding: 'chat-a', context: () => '', delegate }, changed);
    expect(live.state).toBe('live');
    expect(changed).toHaveBeenCalledWith('live', expect.stringContaining('Local microphone preview'));
    expect(peerClose).toHaveBeenCalledOnce(); expect(remote).not.toHaveBeenCalled(); expect(stopped).not.toHaveBeenCalled();
    const closing = live.close(); await vi.advanceTimersByTimeAsync(250); await closing;
    expect(live.state).toBe('closed'); expect(stopped).toHaveBeenCalledOnce(); expect(delegate).not.toHaveBeenCalled();
  });
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
  it('does not lose a confirmed terminal state when the close HTTP request later fails', async () => {
    let rejectClose!: (error: Error) => void;
    let terminal = false;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'start') return Response.json({ id: 'fixture', sdp: 'answer' });
      if (body.action === 'close') return new Promise((_resolve, reject) => { rejectClose = reject; });
      return Response.json({ events: terminal ? [{ cursor: 1, event: { type: 'session.closed', usage: { seconds: 5 } } }] : [] });
    }));
    const states: string[] = [];
    const live = await startManagedLive({ binding: 'a', context: () => '', delegate: vi.fn() }, state => states.push(state));
    await flush();
    const closing = live.close(); terminal = true;
    await vi.advanceTimersByTimeAsync(250); await closing;
    expect(live.state).toBe('closed');
    rejectClose(new Error('late connection reset'));
    await flush();
    expect(live.state).toBe('closed');
  });
  it('aborting during pending answer installation promptly requests provider closure', async () => {
    let answerStarted!: () => void;
    const atAnswer = new Promise<void>(resolve => { answerStarted = resolve; });
    let finishAnswer!: () => void;
    class DelayedPeer extends Peer {
      setRemoteDescription = () => { answerStarted(); return new Promise<void>(resolve => { finishAnswer = resolve; }); };
    }
    vi.stubGlobal('RTCPeerConnection', DelayedPeer);
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      return Response.json(body.action === 'start' ? { id: 'fixture', sdp: 'answer' } : { events: [{ cursor: 1, event: {type: 'session.closed'} }] });
    }));
    const controller = new AbortController();
    const starting = startManagedLive({ binding: 'a', context: () => '', delegate: vi.fn() }, () => {}, controller.signal);
    await atAnswer; controller.abort(); await flush();
    const closedPromptly = requests.some(request => request.action === 'close');
    finishAnswer(); await starting; await flush();
    expect(closedPromptly).toBe(true);
  });
  it('does not install fresh timers after failure cleanup during delayed answer installation', async () => {
    let finishAnswer!: () => void;
    let failPeer!: () => void;
    let answerStarted!: () => void;
    const atAnswer = new Promise<void>(resolve => { answerStarted = resolve; });
    class DelayedFailingPeer extends Peer {
      setRemoteDescription = () => {
        failPeer = () => { this.connectionState = 'failed'; (this.onconnectionstatechange as unknown as (() => void))?.(); };
        answerStarted(); return new Promise<void>(resolve => { finishAnswer = resolve; });
      };
    }
    vi.stubGlobal('RTCPeerConnection', DelayedFailingPeer);
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'start') return Response.json({ id: 'fixture', sdp: 'answer' });
      if (body.action === 'close') throw new Error('close connection reset');
      return Response.json({ events: [] });
    }));
    const starting = startManagedLive({ binding: 'a', context: () => '', delegate: vi.fn() }, () => {});
    await atAnswer; failPeer(); await flush();
    expect(vi.getTimerCount()).toBe(0);
    finishAnswer(); const live = await starting; await flush();
    expect(live.state).toBe('unknown');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces repeated stops and ignores backend output after terminal closure', async () => {
    const requests: Record<string, unknown>[] = [];
    let terminal = false;
    let emit!: (text: string) => Promise<void>;
    let finishTask!: () => void;
    const delegate = vi.fn((_text, _id, update) => { emit = update; return new Promise<void>(resolve => { finishTask = resolve; }); });
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (body.action === 'start') return Response.json({ id:'fixture', sdp:'answer' });
      return Response.json({events: terminal ? [{cursor:3,event:{type:'session.closed'}}] : [
        {cursor:1,event:{type:'session.input_transcript.delta',event_id:'t',delta:'Do work',start_ms:0,end_ms:10}},
        {cursor:2,event:{type:'session.delegation.created',event_id:'d',offset_ms:10,delegation:{id:'d1',target:'client'}}}
      ]});
    }));
    const live = await startManagedLive({binding:'a',context:()=>'',delegate},()=>{});
    await flush(); expect(delegate).toHaveBeenCalledOnce();
    const one = live.close(); const two = live.close(); expect(one).toBe(two);
    terminal = true; await vi.advanceTimersByTimeAsync(250); await one;
    await emit('Late backend success'); finishTask(); await flush();
    expect(requests.filter(request => request.action === 'close')).toHaveLength(1);
    expect(requests.filter(request => request.action === 'event')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not fund a session when peer failure occurs during offer creation', async () => {
    class EarlyFailurePeer extends Peer {
      createOffer = async () => {
        this.connectionState = 'failed'; (this.onconnectionstatechange as unknown as (() => void))?.();
        return this.localDescription;
      };
    }
    vi.stubGlobal('RTCPeerConnection', EarlyFailurePeer);
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body)); return Response.json({error:'missing id'}, {status:400});
    }));
    await expect(startManagedLive({binding:'a',context:()=>'',delegate:vi.fn()},()=>{})).rejects.toThrow();
    await flush();
    expect(requests.some(request => request.action === 'start')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('closes a late funded id after pre-id peer failure has already cleaned up', async () => {
    const peers: Peer[] = [];
    class CapturedPeer extends Peer { constructor() { super(); peers.push(this); } }
    vi.stubGlobal('RTCPeerConnection', CapturedPeer);
    let finishStart!: (response: Response) => void;
    let atStart!: () => void;
    const startReached = new Promise<void>(resolve => { atStart = resolve; });
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (body.action === 'start') { atStart(); return new Promise<Response>(resolve => { finishStart = resolve; }); }
      if (!body.id) return Response.json({error:'missing id'}, {status:400});
      return Response.json({events:[]});
    }));
    const states: string[] = [];
    const starting = startManagedLive({binding:'a',context:()=>'',delegate:vi.fn()},state=>states.push(state));
    await startReached; const peer = peers[0]; peer.connectionState = 'failed'; (peer.onconnectionstatechange as unknown as (() => void))?.();
    await flush(); expect(vi.getTimerCount()).toBe(0);
    finishStart(Response.json({id:'late-funded',sdp:'answer'}));
    const live = await starting; await flush();
    expect(live.state).toBe('unknown');
    expect(states).not.toContain('live');
    expect(requests.filter(request=>request.action==='close' && request.id==='late-funded')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds hung provider setup and closes a late funded ID exactly once', async () => {
    let finishStart!: (response: Response) => void;
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (body.action === 'start') return new Promise<Response>(resolve => { finishStart = resolve; });
      return Response.json({events:[]});
    }));
    const states: string[] = [];
    const starting = startManagedLive({binding:'a',context:()=>'',delegate:vi.fn()}, state=>states.push(state));
    const rejected = expect(starting).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(45_000); await rejected;
    expect(states.at(-1)).toBe('unknown');
    finishStart(Response.json({id:'late-timeout',sdp:'answer'})); await flush();
    expect(requests.filter(r=>r.action==='close' && r.id==='late-timeout')).toHaveLength(1);
    expect(states).not.toContain('live'); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds hung microphone setup and stops a late granted stream without funding', async () => {
    let grant!: (stream: unknown) => void; const stop = vi.fn();
    vi.stubGlobal('navigator', {mediaDevices:{getUserMedia:()=>new Promise(resolve=>{grant=resolve;})}});
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const starting = startManagedLive({binding:'a',context:()=>'',delegate:vi.fn()},()=>{});
    const rejected = expect(starting).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(45_000); await rejected;
    grant({getTracks:()=>[{stop}]}); await flush();
    expect(stop).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses delayed speech timestamps and gives explicit resume an independent idle and usage budget', async () => {
    const origin = Date.now(); let starts = 0; const closed = new Set<string>();
    const closeTimes: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if(body.action==='start') return Response.json({id:`session-${++starts}`,sdp:'answer'});
      if(body.action==='close') { closed.add(body.id); closeTimes.push(Date.now()-origin); return Response.json({state:'closing'}); }
      if(closed.has(body.id)) return Response.json({events:[{cursor:3,event:{type:'session.closed',usage:{seconds:body.id==='session-1'?51:30}}}]});
      const delayed = body.id==='session-1' && Date.now()-origin >= 28000;
      return Response.json({events:delayed?[{cursor:1,event:{type:'session.input_transcript.delta',event_id:'speech',delta:'hello',start_ms:19000,end_ms:20000}}]:[]});
    }));
    const backend={binding:'a',context:()=>'',delegate:vi.fn()};
    const first = await startManagedLive(backend,()=>{});
    await vi.advanceTimersByTimeAsync(49800); expect(first.state).toBe('live');
    await vi.advanceTimersByTimeAsync(500); expect(first.state).toBe('closed');
    expect(closeTimes[0]).toBe(50000);
    expect(first.usage.providerConnectedSeconds).toBe(51);
    expect(first.usage.recognizedSpeechSecondsDiagnostic).toBe(1);
    const second = await startManagedLive(backend,()=>{});
    expect(second.usage.providerConnectedSeconds).toBeNull();
    expect(second.usage.recognizedSpeechSecondsDiagnostic).toBe(0);
    await vi.advanceTimersByTimeAsync(29800); expect(second.state).toBe('live');
    await vi.advanceTimersByTimeAsync(500); expect(second.state).toBe('closed');
    expect(starts).toBe(2); expect(backend.delegate).not.toHaveBeenCalled();
    expect(second.usage.providerConnectedSeconds).toBe(30);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('gives slow startup a full initial inactivity window after readiness', async () => {
    let finishStart!: (response: Response) => void;
    let atStart!: () => void;
    const reached = new Promise<void>(resolve => {atStart=resolve;}); let closed=false;
    vi.stubGlobal('fetch', vi.fn(async(_url,init)=>{
      const body=JSON.parse(init.body);
      if(body.action==='start'){atStart();return new Promise<Response>(resolve=>{finishStart=resolve;});}
      if(body.action==='close'){closed=true;return Response.json({state:'closing'});}
      return Response.json({events:closed?[{cursor:1,event:{type:'session.closed',usage:{seconds:32}}}]:[]});
    }));
    const starting=startManagedLive({binding:'a',context:()=>'',delegate:vi.fn()},()=>{});
    await reached; await vi.advanceTimersByTimeAsync(32000);
    finishStart(Response.json({id:'slow',sdp:'answer'})); const live=await starting;
    expect(live.state).toBe('live');
    await vi.advanceTimersByTimeAsync(29800); expect(live.state).toBe('live');
    await vi.advanceTimersByTimeAsync(500);
    expect(live.state).toBe('closed');
  });
  it('keeps polling and updating context during unresolved work, then delivers results to the resumed talker without old delegation IDs', async () => {
    const bus = new LiveConversationBridge(); let context = 'Current task is working'; let starts = 0;
    const closed = new Set<string>(); const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (body.action === 'start') return Response.json({id:`voice-${++starts}`,sdp:'answer'});
      if (body.action === 'close') { closed.add(body.id); return Response.json({state:'closing'}); }
      if (body.action === 'event') return Response.json({state:'submitted'});
      return Response.json({events:closed.has(body.id) ? [{cursor:3,event:{type:'session.closed',usage:{seconds:15}}}] : body.id === 'voice-1' ? [
        {cursor:1,event:{type:'session.input_transcript.delta',event_id:'speech',delta:'Work on this',start_ms:0,end_ms:1}},
        {cursor:2,event:{type:'session.delegation.created',event_id:'delegation',delegation:{id:'old-delegation',target:'client'}}},
      ] : []});
    }));
    const delegate = vi.fn(() => new Promise<void>(() => {}));
    const backend = {binding:'same-task',context:()=>context,delegate,subscribe:bus.subscribe};
    const first = await startManagedLive(backend,()=>{}); await flush();
    expect(delegate).toHaveBeenCalledOnce();
    context = 'Verified progress: one step finished; task still working';
    await vi.advanceTimersByTimeAsync(1250);
    expect(requests.some(r=>r.action==='event' && (r.event as Record<string,unknown>).type==='session.thinking.append' && String((r.event as Record<string,unknown>).content).includes('one step finished'))).toBe(true);
    const closing = first.close(); await vi.advanceTimersByTimeAsync(250); await closing;
    const second = await startManagedLive(backend,()=>{}); await bus.publish('Backend confirmed the result');
    const result = requests.findLast(r=>r.action==='event');
    expect(result).toMatchObject({id:'voice-2',event:{type:'session.commentary.append',delegation_id:null,content:'Backend confirmed the result'}});
    expect(delegate).toHaveBeenCalledOnce();
    const end = second.close(); await vi.advanceTimersByTimeAsync(250); await end;
    expect(vi.getTimerCount()).toBe(0);
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
  it('closes after 30 seconds despite noise, typing and explicit UI activity; retains backend work', async () => {
    class NoisyContext extends AudioContextFixture {
      createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (data: Uint8Array) => data.fill(160) }; }
    }
    vi.stubGlobal('AudioContext', NoisyContext);
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
    await vi.advanceTimersByTimeAsync(29_000);
    window.dispatchEvent(new Event('keydown')); window.dispatchEvent(new Event('pointerdown')); live.activity();
    await vi.advanceTimersByTimeAsync(800); expect(live.state).toBe('live');
    await vi.advanceTimersByTimeAsync(500); expect(live.state).toBe('closed');
    expect(states).toContain('closing');
    expect(live.usage.providerConnectedSeconds).toBe(60);
    expect(live.usage.recognizedSpeechSecondsDiagnostic).toBe(0);
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
