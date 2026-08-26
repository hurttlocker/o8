import { describe, expect, it } from 'vitest';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from './history-serde';

describe('deserializeStoredTranscript', () => {
  it('preserves the monotonic persisted message version', () => {
    const [entry] = deserializeStoredTranscript([{
      id: 'assistant-1',
      role: 'assistant',
      content: 'Done.',
      persistedVersion: 4,
    }]);

    expect(entry.persistedVersion).toBe(4);
  });

  it('round-trips per-turn backend attribution', () => {
    const stored = serializeTranscriptForStorage([{
      id: 'assistant-1',
      role: 'assistant',
      text: 'Done.',
      backend: 'codex',
      model: 'gpt-5.6',
    }], { timestampFallback: 'zero' });

    expect(deserializeStoredTranscript(stored)[0]).toMatchObject({
      backend: 'codex',
      model: 'gpt-5.6',
    });
  });

  it('does not promote legacy mission-complete cards to the live edge', () => {
    const [entry] = deserializeStoredTranscript([{
      id: 'orch-mission-complete-old',
      role: 'system',
      content: '2 packets merged & archived',
      statusEvent: { kind: 'mission-complete', mergedCount: 2, archivedCount: 2 },
    }]);

    expect(entry?.timestamp).toBe(0);
    expect(entry?.timestampLabel).toBe('');
  });
});
