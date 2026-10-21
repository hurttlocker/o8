import { expect, it, vi } from 'vitest';
import { claimVisualAudio, registerVisualLive, subscribeVisualSpeech, visualLiveState } from './visual-live-context';
const scope = { principal: 'fixture', target: { repoPath: '/fixture', threadId: 'thoughts-fixture' }, routing: {
  backend: 'codex' as const, model: 'selected-model', effort: 'low' as const, permissionMode: 'plan' as const, mode: 'single' as const, pickedMode: 'solo' as const, collide: false,
} };
it('shares one existing microphone only with the exact account, chat, runtime and settings', () => {
  const live = registerVisualLive(scope, 'voice-fixture'); live.state('live');
  expect(visualLiveState(scope)).toBe('matching');
  expect(visualLiveState({ ...scope, principal: 'another-account' })).toBe('other');
  expect(visualLiveState({ ...scope, routing: { ...scope.routing, permissionMode: 'full' } })).toBe('other');
  const release = claimVisualAudio({ id: 'capture-fixture', scope, shared: true, prepare: vi.fn() });
  const heard = vi.fn(); const unsubscribe = subscribeVisualSpeech(heard);
  const event = { type: 'session.input_transcript.delta', event_id: 'fragment-a', delta: 'Keep this label.', start_ms: 10, end_ms: 300 };
  live.input({ ...event, type: 'session.output_transcript.delta' }, 'session-a');
  live.input(event, 'session-a'); live.input(event, 'session-a');
  expect(heard).toHaveBeenCalledTimes(1);
  expect(heard).toHaveBeenCalledWith(expect.objectContaining({ id: 'fragment-a', text: event.delta, startMs: 10, endMs: 300, sessionId: 'session-a' }));
  live.state('connecting'); live.input({ ...event, event_id: 'unready' }, 'session-a'); expect(heard).toHaveBeenCalledTimes(1);
  live.state('live'); live.input(event, 'session-b'); expect(heard).toHaveBeenCalledTimes(2);
  release(); unsubscribe(); live.state('closed'); expect(visualLiveState(scope)).toBe('none');
});
it('refuses a second recorder and retains uncertain voice ownership until closure is confirmed', () => {
  const release = claimVisualAudio({ id: 'standalone-capture', scope, shared: false, prepare: vi.fn() });
  expect(() => registerVisualLive(scope, 'second-microphone')).toThrow('Finish the current visual recording'); release();
  const live = registerVisualLive(scope, 'uncertain-voice'); live.state('unknown');
  expect(() => claimVisualAudio({ id: 'new-capture', scope, shared: false, prepare: vi.fn() })).toThrow('Another chat owns voice');
  live.state('closed');
});
