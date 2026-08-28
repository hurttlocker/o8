import { describe, expect, it } from 'vitest';

import {
  applyBroadcastCommentaryUpdate,
  BROADCAST_COMMENTARY_FALLBACK,
  resolveBroadcastCommentaryDefaults,
} from './broadcast-commentary-defaults';

describe('Broadcast voice operator defaults', () => {
  it('starts with safe quiet hours and every high-signal subscription enabled', () => {
    expect(resolveBroadcastCommentaryDefaults({})).toMatchObject({
      broadcastVoice: 'off',
      broadcastVoiceQuietHours: 'on',
      broadcastVoiceQuietStart: '22:00',
      broadcastVoiceQuietEnd: '08:00',
      broadcastVoiceAttention: true,
      broadcastVoiceApprovals: true,
      broadcastVoiceReviews: true,
      broadcastVoiceFailures: true,
      broadcastVoiceCompletions: true,
      broadcastVoiceCalendar: true,
      broadcastVoiceCalendarLeadMinutes: 15,
      broadcastVoiceTimeCheckins: true,
    });
  });

  it('round-trips valid policy updates and rejects malformed local times', () => {
    const stored = { ...BROADCAST_COMMENTARY_FALLBACK };
    applyBroadcastCommentaryUpdate(stored, {
      broadcastVoice: 'on',
      broadcastVoiceQuietStart: '21:30',
      broadcastVoiceQuietEnd: '07:15',
      broadcastVoiceCompletions: false,
      broadcastVoiceCalendarLeadMinutes: 20,
    });
    expect(stored).toMatchObject({
      broadcastVoice: 'on',
      broadcastVoiceQuietStart: '21:30',
      broadcastVoiceQuietEnd: '07:15',
      broadcastVoiceCompletions: false,
      broadcastVoiceCalendarLeadMinutes: 20,
    });
    expect(() => applyBroadcastCommentaryUpdate(stored, {
      broadcastVoiceQuietStart: '25:00',
    })).toThrow(/HH:MM/);
  });
});
