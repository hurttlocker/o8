import { describe, expect, it } from 'vitest';

import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { getRuntime } from '@/lib/runtimes';

describe('session transform capability truth', () => {
  it('keeps the product catalog and runtime adapter aligned', () => {
    for (const [runtimeId, productCapability] of Object.entries(ORCHESTRATOR_RUNTIMES)) {
      const productTransforms = 'sessionTransforms' in productCapability
        ? productCapability.sessionTransforms
        : undefined;
      const runtime = getRuntime(runtimeId);
      expect(runtime?.capabilities.sessionTransforms).toEqual(productTransforms);
      if (productTransforms && Object.values(productTransforms).some(Boolean)) {
        expect(typeof runtime?.transformSession).toBe('function');
        expect(typeof runtime?.getSessionTransformCapabilities).toBe('function');
      }
    }
  });
});
