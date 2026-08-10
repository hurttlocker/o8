import { describe, expect, it } from 'vitest';
import { normalizeRealtimeInternalOrigin } from './publisher';

describe('normalizeRealtimeInternalOrigin', () => {
  it('converts websocket origins into fetchable HTTP origins', () => {
    expect(normalizeRealtimeInternalOrigin('ws://127.0.0.1:47105')).toBe('http://127.0.0.1:47105');
    expect(normalizeRealtimeInternalOrigin('wss://relay.example/internal')).toBe('https://relay.example/internal');
  });

  it('keeps an explicit HTTP override unchanged', () => {
    expect(normalizeRealtimeInternalOrigin('http://127.0.0.1:47105')).toBe('http://127.0.0.1:47105');
  });
});
