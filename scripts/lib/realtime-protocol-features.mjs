export const MOBILE_INBOX_DELTA_FEATURE_ID = 'mobile-inbox-delta-v1';

export function requireRealtimeFeature(optionalFeatures, featureId, eventName) {
  const feature = optionalFeatures.find((candidate) => candidate.id === featureId);
  if (!feature) {
    throw new Error(`Missing required realtime optional feature: ${featureId}.`);
  }
  if (!feature.events?.includes(eventName)) {
    throw new Error(`Realtime optional feature ${featureId} must own ${eventName}.`);
  }
  return feature;
}
