import { describe, expect, it } from 'vitest';

import { isProductTelemetryAllowed } from './policy';

describe('product telemetry privacy policy', () => {
  it('requires affirmative consent and lets local-only mode fail closed', () => {
    expect(isProductTelemetryAllowed({ productTelemetryEnabled: false, localOnlyMode: false })).toBe(false);
    expect(isProductTelemetryAllowed({ productTelemetryEnabled: true, localOnlyMode: false })).toBe(true);
    expect(isProductTelemetryAllowed({ productTelemetryEnabled: true, localOnlyMode: true })).toBe(false);
  });
});
