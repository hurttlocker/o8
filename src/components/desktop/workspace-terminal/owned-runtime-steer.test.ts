import { describe, expect, it } from 'vitest';

import {
  ownedRuntimeCanAcceptInput,
  shouldHoldOwnedRuntimeSteer,
} from './owned-runtime-steer';

describe('owned runtime steer queue', () => {
  it('holds a retryable surface-not-ready response instead of rendering a failed attempt', () => {
    expect(shouldHoldOwnedRuntimeSteer(false, {
      ok: false,
      retryable: true,
      reason: 'surface_not_ready',
    })).toBe(true);

    expect(shouldHoldOwnedRuntimeSteer(false, {
      ok: false,
      retryable: false,
      reason: 'surface_not_ready',
    })).toBe(false);
  });

  it('requires the exact owned surface send-input capability before auto-delivery', () => {
    expect(ownedRuntimeCanAcceptInput([
      {
        sessionKey: 'codex-owned:active',
        runtimeSurface: {
          id: 'codex-owned:active',
          capabilities: { sendInput: false },
        },
      },
      {
        sessionKey: 'codex-owned:ready',
        runtimeSurface: {
          id: 'codex-owned:ready',
          capabilities: { sendInput: true },
        },
      },
    ], 'codex-owned:ready')).toBe(true);

    expect(ownedRuntimeCanAcceptInput([
      {
        sessionKey: 'codex-owned:active',
        runtimeSurface: {
          id: 'codex-owned:active',
          capabilities: { sendInput: false },
        },
      },
    ], 'codex-owned:active')).toBe(false);
  });
});
