export interface ProductTelemetryPolicy {
  productTelemetryEnabled: boolean;
  localOnlyMode: boolean;
}

/**
 * Central privacy predicate. #1451 has not shipped a local-only setting yet;
 * its future resolver plugs into `localOnlyMode` and wins over consent.
 */
export function isProductTelemetryAllowed(policy: ProductTelemetryPolicy): boolean {
  return policy.productTelemetryEnabled === true && policy.localOnlyMode !== true;
}
