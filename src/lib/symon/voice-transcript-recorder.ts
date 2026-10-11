/**
 * Records a realtime voice session's finished lines into the Symon store
 * (#3455), so voice conversations appear in the Symon tab beside the other
 * threads.
 *
 * Each completed line is written once, in the order its event arrived: the
 * operator's line when its input transcription completes, Symon's line when
 * its audio transcript is done. The item id is the request id, so a repeated
 * event records nothing new. Writes never block or fail the voice session.
 */

const USER_DONE = 'conversation.item.input_audio_transcription.completed';
const ASSISTANT_DONE = new Set(['response.output_audio_transcript.done', 'response.audio_transcript.done']);
const MAX_TEXT = 8_000;

export type SymonVoiceRecordPost = (body: {
  key: string;
  requestId: string;
  entries: Array<{ role: 'user' | 'assistant'; text: string }>;
}) => Promise<unknown>;

export interface SymonVoiceTranscriptRecorder {
  readonly key: string;
  observe(event: Record<string, unknown>): void;
  /** Resolves once every line observed so far has been posted. */
  flush(): Promise<void>;
}

export const postSymonVoiceRecord: SymonVoiceRecordPost = (body) => fetch('/api/panel/symon/conversations/record', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function newSessionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createSymonVoiceTranscriptRecorder(
  post: SymonVoiceRecordPost = postSymonVoiceRecord,
  sessionId: string = newSessionId(),
): SymonVoiceTranscriptRecorder {
  const key = `voice:${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}`;
  let sequence = 0;
  let queue: Promise<void> = Promise.resolve();

  const record = (role: 'user' | 'assistant', itemId: unknown, transcript: unknown) => {
    if (typeof transcript !== 'string') return;
    const text = transcript.trim().slice(0, MAX_TEXT);
    if (!text) return;
    sequence += 1;
    const id = typeof itemId === 'string' && itemId ? itemId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 140) : `line-${sequence}`;
    const body = { key, requestId: `${role === 'user' ? 'u' : 'a'}-${id}`, entries: [{ role, text }] };
    queue = queue.then(() => post(body)).then(() => {}, () => {});
  };

  return {
    key,
    observe(event) {
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === USER_DONE) record('user', event.item_id, event.transcript);
      else if (ASSISTANT_DONE.has(type)) record('assistant', event.item_id, event.transcript);
    },
    flush: () => queue,
  };
}
