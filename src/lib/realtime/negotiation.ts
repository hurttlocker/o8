export interface RealtimeNegotiationInput {
  clientMin: number;
  clientMax: number;
  requestedFeatures: readonly string[];
  requiredFeatures: readonly unknown[];
  serverMin: number;
  serverCurrent: number;
  serverFeatures: readonly {
    id: string;
    introducedIn: number;
  }[];
}

export type RealtimeNegotiationResult =
  | {
      ok: true;
      selectedProtocol: number;
      selectedFeatures: string[];
    }
  | {
      ok: false;
      reason: 'protocol_mismatch' | 'required_feature_unavailable';
      unsupportedRequired: string | null;
    };

export function optionalRealtimeAudienceMatches<TFeature extends string>(
  audience: string | undefined,
  clientFeatures: ReadonlySet<TFeature>,
  optionalFeatures: readonly TFeature[],
): boolean {
  if (!audience) return true;
  const feature = optionalFeatures.find((candidate) => candidate === audience);
  return feature === undefined || clientFeatures.has(feature);
}

/** Select the highest protocol both peers support, then gate features to it. */
export function negotiateRealtimeHello(
  input: RealtimeNegotiationInput,
): RealtimeNegotiationResult {
  const selectedProtocol = Math.min(input.serverCurrent, input.clientMax);
  if (selectedProtocol < input.serverMin || selectedProtocol < input.clientMin) {
    return { ok: false, reason: 'protocol_mismatch', unsupportedRequired: null };
  }
  const available = new Set(input.serverFeatures
    .filter((feature) => feature.introducedIn <= selectedProtocol)
    .map((feature) => feature.id));
  const unsupported = input.requiredFeatures.find((feature) => (
    typeof feature !== 'string' || !available.has(feature)
  ));
  if (unsupported !== undefined) {
    return {
      ok: false,
      reason: 'required_feature_unavailable',
      unsupportedRequired: String(unsupported),
    };
  }
  return {
    ok: true,
    selectedProtocol,
    selectedFeatures: input.requestedFeatures.filter((feature) => available.has(feature)),
  };
}
