import { describe, expect, it } from 'vitest';

import {
  MOBILE_INBOX_DELTA_FEATURE_ID,
  requireRealtimeFeature,
} from '../scripts/lib/realtime-protocol-features.mjs';

describe('realtime protocol feature generation', () => {
  it('binds the mobile inbox capability by canonical id after feature reordering', () => {
    const features = [
      { id: 'future-presence-v1', events: ['presence.delta'] },
      { id: MOBILE_INBOX_DELTA_FEATURE_ID, events: ['mobile.inbox.delta'] },
    ];

    expect(requireRealtimeFeature(
      features,
      MOBILE_INBOX_DELTA_FEATURE_ID,
      'mobile.inbox.delta',
    ).id).toBe('mobile-inbox-delta-v1');
  });

  it('fails generation when the named feature no longer owns its event', () => {
    expect(() => requireRealtimeFeature(
      [{ id: MOBILE_INBOX_DELTA_FEATURE_ID, events: ['presence.delta'] }],
      MOBILE_INBOX_DELTA_FEATURE_ID,
      'mobile.inbox.delta',
    )).toThrow('must own mobile.inbox.delta');
  });
});
