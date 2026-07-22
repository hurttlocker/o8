import { describe, expect, it, vi } from 'vitest';
import {
  createRealtimeApprovalAudioGate,
  createRealtimeUtteranceTracker,
  realtimeCallReviewGuardId,
} from './realtime-client';

describe('Realtime native cancellation guards', () => {
  it('binds every ordinary native invocation to its exact session and call', () => {
    expect(realtimeCallReviewGuardId('session-1', 'plan-call'))
      .toBe('desktop:["session-1","plan-call"]');
    expect(realtimeCallReviewGuardId('session-1', 'other-call'))
      .not.toBe(realtimeCallReviewGuardId('session-1', 'plan-call'));
    expect(realtimeCallReviewGuardId('a:b', 'c')).not.toBe(realtimeCallReviewGuardId('a', 'b:c'));
  });
});

describe('Realtime utterance attribution', () => {
  it('retains one transcript across chained responses in the same voice turn', async () => {
    const tracker = createRealtimeUtteranceTracker();
    tracker.observe({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    tracker.observe({ type: 'response.created', response: { id: 'response-1' } });
    tracker.observe({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: '  Create a reminder and a note  ',
    });
    tracker.observe({ type: 'response.created', response: { id: 'response-2' } });

    await expect(tracker.transcriptForResponse('response-1')).resolves.toBe('Create a reminder and a note');
    await expect(tracker.transcriptForResponse('response-2')).resolves.toBe('Create a reminder and a note');
  });

  it('waits for a late transcript tied to the exact response item', async () => {
    const tracker = createRealtimeUtteranceTracker();
    tracker.observe({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    tracker.observe({ type: 'response.created', response: { id: 'response-1' } });
    const pending = tracker.transcriptForResponse('response-1');
    tracker.observe({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'First command',
    });

    await expect(pending).resolves.toBe('First command');
  });

  it('does not misattribute an older late transcript after a new turn starts', async () => {
    const tracker = createRealtimeUtteranceTracker();
    tracker.observe({ type: 'input_audio_buffer.speech_started', item_id: 'item-a' });
    tracker.observe({ type: 'response.created', response: { id: 'response-a' } });
    tracker.observe({ type: 'input_audio_buffer.speech_started', item_id: 'item-b' });
    tracker.observe({ type: 'response.created', response: { id: 'response-b' } });
    tracker.observe({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-a',
      transcript: 'Older command',
    });
    tracker.observe({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-b',
      transcript: 'New command',
    });

    await expect(tracker.transcriptForResponse('response-a')).resolves.toBe('Older command');
    await expect(tracker.transcriptForResponse('response-b')).resolves.toBe('New command');
  });

  it('waits for the terminal ASR event and reports transcription failure', async () => {
    const tracker = createRealtimeUtteranceTracker();
    tracker.observe({ type: 'input_audio_buffer.committed', item_id: 'item-failed' });
    tracker.observe({ type: 'response.created', response: { id: 'response-failed' } });
    const pending = tracker.transcriptForResponse('response-failed');
    tracker.observe({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item-failed',
    });

    await expect(pending).resolves.toBeNull();
  });

  it('bounds a protected transcript wait when ASR never emits a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const tracker = createRealtimeUtteranceTracker();
      tracker.observe({ type: 'input_audio_buffer.committed', item_id: 'item-timeout' });
      tracker.observe({ type: 'response.created', response: { id: 'response-timeout' } });
      const pending = tracker.transcriptForResponse('response-timeout', 50);

      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Realtime packet approval audio gate', () => {
  it('waits for output playback to stop before releasing an approval', async () => {
    const gate = createRealtimeApprovalAudioGate();
    gate.observe({ type: 'response.created', response: { id: 'response-review' } });
    gate.observe({ type: 'output_audio_buffer.started', response_id: 'response-review' });
    const pending = gate.waitForPlaybackStop('response-review');
    let released = false;
    void pending.then(() => { released = true; });

    await Promise.resolve();
    expect(released).toBe(false);

    gate.observe({ type: 'output_audio_buffer.stopped', response_id: 'response-review' });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('remembers a completed playback when audio stops before response.done', async () => {
    const gate = createRealtimeApprovalAudioGate();
    gate.observe({ type: 'response.created', response: { id: 'response-review' } });
    gate.observe({ type: 'output_audio_buffer.started' });
    gate.observe({ type: 'output_audio_buffer.stopped' });
    gate.observe({
      type: 'response.done',
      response: { id: 'response-review', status: 'completed' },
    });

    await expect(gate.waitForPlaybackStop('response-review')).resolves.toEqual({ ok: true });
  });

  it('keeps stopped playback cancellable after response.done until it is claimed', async () => {
    const gate = createRealtimeApprovalAudioGate();
    gate.observe({ type: 'response.created', response: { id: 'response-late-asr' } });
    gate.observe({ type: 'output_audio_buffer.started' });
    gate.observe({ type: 'output_audio_buffer.stopped' });
    gate.observe({
      type: 'response.done',
      response: { id: 'response-late-asr', status: 'completed' },
    });
    const stopped = gate.waitForPlaybackStop('response-late-asr');

    gate.observe({ type: 'input_audio_buffer.speech_started', item_id: 'next-turn' });

    await expect(stopped).resolves.toEqual({ ok: true });
    expect(gate.claimForProtectedCall('response-late-asr')).toEqual({
      ok: false,
      reason: 'interrupted',
    });
  });

  it('allows exactly one protected call to claim a completed review playback', async () => {
    const gate = createRealtimeApprovalAudioGate();
    gate.observe({ type: 'response.created', response: { id: 'response-one-shot' } });
    gate.observe({ type: 'output_audio_buffer.started' });
    gate.observe({ type: 'output_audio_buffer.stopped' });
    await expect(gate.waitForPlaybackStop('response-one-shot')).resolves.toEqual({ ok: true });

    expect(gate.claimForProtectedCall('response-one-shot')).toEqual({ ok: true });
    expect(gate.claimForProtectedCall('response-one-shot')).toEqual({
      ok: false,
      reason: 'audio_already_claimed',
    });
  });

  it('fails closed when playback is cleared or interrupted by new speech', async () => {
    const cleared = createRealtimeApprovalAudioGate();
    cleared.observe({ type: 'response.created', response: { id: 'response-cleared' } });
    cleared.observe({ type: 'output_audio_buffer.started' });
    cleared.observe({ type: 'output_audio_buffer.cleared' });
    cleared.observe({ type: 'output_audio_buffer.stopped' });
    await expect(cleared.waitForPlaybackStop('response-cleared')).resolves.toEqual({
      ok: false,
      reason: 'interrupted',
    });

    const interrupted = createRealtimeApprovalAudioGate();
    interrupted.observe({ type: 'response.created', response: { id: 'response-interrupted' } });
    interrupted.observe({ type: 'output_audio_buffer.started' });
    interrupted.observe({ type: 'input_audio_buffer.speech_started', item_id: 'next-turn' });
    await expect(interrupted.waitForPlaybackStop('response-interrupted')).resolves.toEqual({
      ok: false,
      reason: 'interrupted',
    });

    const interruptedAfterStop = createRealtimeApprovalAudioGate();
    interruptedAfterStop.observe({ type: 'response.created', response: { id: 'response-barged' } });
    interruptedAfterStop.observe({ type: 'output_audio_buffer.started' });
    interruptedAfterStop.observe({ type: 'output_audio_buffer.stopped' });
    interruptedAfterStop.observe({ type: 'input_audio_buffer.speech_started', item_id: 'cancel-turn' });
    await expect(interruptedAfterStop.waitForPlaybackStop('response-barged')).resolves.toEqual({
      ok: false,
      reason: 'interrupted',
    });
  });

  it('fails closed for missing audio, incomplete responses, and teardown', async () => {
    const missing = createRealtimeApprovalAudioGate();
    missing.observe({
      type: 'response.done',
      response: { id: 'response-silent', status: 'completed' },
    });
    await expect(missing.waitForPlaybackStop('response-silent')).resolves.toEqual({
      ok: false,
      reason: 'no_audio',
    });

    const incomplete = createRealtimeApprovalAudioGate();
    incomplete.observe({ type: 'response.created', response: { id: 'response-cancelled' } });
    incomplete.observe({ type: 'output_audio_buffer.started' });
    incomplete.observe({
      type: 'response.done',
      response: { id: 'response-cancelled', status: 'cancelled' },
    });
    await expect(incomplete.waitForPlaybackStop('response-cancelled')).resolves.toEqual({
      ok: false,
      reason: 'response_incomplete',
    });

    const ended = createRealtimeApprovalAudioGate();
    ended.observe({ type: 'response.created', response: { id: 'response-ended' } });
    ended.observe({ type: 'output_audio_buffer.started' });
    const pending = ended.waitForPlaybackStop('response-ended');
    ended.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'session_ended' });
  });

  it('times out instead of dispatching when playback never reaches stopped', async () => {
    vi.useFakeTimers();
    try {
      const gate = createRealtimeApprovalAudioGate(50);
      gate.observe({ type: 'response.created', response: { id: 'response-stuck' } });
      gate.observe({ type: 'output_audio_buffer.started' });
      const pending = gate.waitForPlaybackStop('response-stuck');

      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
