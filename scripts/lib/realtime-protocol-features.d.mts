export interface RealtimeOptionalFeatureDefinition {
  id: string;
  events?: readonly string[];
}

export const MOBILE_INBOX_DELTA_FEATURE_ID: 'mobile-inbox-delta-v1';

export function requireRealtimeFeature<TFeature extends RealtimeOptionalFeatureDefinition>(
  optionalFeatures: readonly TFeature[],
  featureId: string,
  eventName: string,
): TFeature;
