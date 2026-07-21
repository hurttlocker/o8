import { describe, expect, it } from 'vitest';
import { createRealtimeUtteranceTracker } from './realtime-client';

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
});
