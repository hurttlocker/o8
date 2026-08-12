import { describe, expect, it } from 'vitest';

import { negotiateRealtimeHello, optionalRealtimeAudienceMatches } from './negotiation';

describe('realtime protocol negotiation', () => {
  it('selects v1 for a v1-only client when the server also supports v2', () => {
    expect(negotiateRealtimeHello({
      clientMin: 1,
      clientMax: 1,
      requestedFeatures: ['v1-feature', 'v2-feature'],
      requiredFeatures: [],
      serverMin: 1,
      serverCurrent: 2,
      serverFeatures: [
        { id: 'v1-feature', introducedIn: 1 },
        { id: 'v2-feature', introducedIn: 2 },
      ],
    })).toEqual({
      ok: true,
      selectedProtocol: 1,
      selectedFeatures: ['v1-feature'],
    });
  });

  it('rejects a feature required before the selected protocol introduced it', () => {
    expect(negotiateRealtimeHello({
      clientMin: 1,
      clientMax: 1,
      requestedFeatures: ['v2-feature'],
      requiredFeatures: ['v2-feature'],
      serverMin: 1,
      serverCurrent: 2,
      serverFeatures: [{ id: 'v2-feature', introducedIn: 2 }],
    })).toEqual({
      ok: false,
      reason: 'required_feature_unavailable',
      unsupportedRequired: 'v2-feature',
    });
  });

  it('gates every optional-feature audience instead of one positional feature', () => {
    const optionalFeatures = ['future-presence-v1', 'mobile-inbox-delta-v1'] as const;
    const clientFeatures = new Set<(typeof optionalFeatures)[number]>(['mobile-inbox-delta-v1']);

    expect(optionalRealtimeAudienceMatches(
      'future-presence-v1',
      clientFeatures,
      optionalFeatures,
    )).toBe(false);
    expect(optionalRealtimeAudienceMatches(
      'mobile-inbox-delta-v1',
      clientFeatures,
      optionalFeatures,
    )).toBe(true);
    expect(optionalRealtimeAudienceMatches('mobile-inbox-legacy', clientFeatures, optionalFeatures)).toBe(true);
  });
});
