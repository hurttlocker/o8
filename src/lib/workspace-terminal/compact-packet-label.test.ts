import { describe, expect, it } from 'vitest';

import { compactPacketLabel } from './compact-packet-label';

describe('compactPacketLabel', () => {
  it('strips conventional commit prefixes and keeps three meaningful words by default', () => {
    expect(compactPacketLabel('feat(orchestrator): slash commands — /compact /clear /focus')).toBe('Slash commands');
    expect(compactPacketLabel('design(orchestrator): redesign Edit File cards in Rams style')).toBe('Redesign edit file');
  });

  it('keeps hyphenated words intact and honors maxWords', () => {
    expect(compactPacketLabel('feat(orchestrator): thinking-effort per-turn knob in composer footer')).toBe('Thinking-effort per-turn knob');
    expect(compactPacketLabel('fix: prevent stale mobile transcript replay', 2)).toBe('Prevent stale');
  });

  it('never falls back to slicing a sessionKey for a label', () => {
    expect(compactPacketLabel('codex-owned:pkt-a3f99b36-5e4f-4acd-b006-e264389ae527')).toBe('Pkt-a3f99b36-5e4f-4acd-b006-e264389ae527');
  });

  it('handles empty and degenerate inputs', () => {
    expect(compactPacketLabel(null)).toBe('');
    expect(compactPacketLabel(undefined)).toBe('');
    expect(compactPacketLabel('   ')).toBe('');
    expect(compactPacketLabel('fix: — / + ·')).toBe('— / + ·');
  });
});
