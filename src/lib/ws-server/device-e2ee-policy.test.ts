import { describe, expect, it } from 'vitest';

import { deviceE2eeFailureAction } from './device-e2ee-policy';

describe('enrolled device E2EE policy', () => {
  it.each(['handshake_timeout', 'handshake_init_failed'] as const)(
    'fails closed on %s without authorizing plaintext state',
    (failure) => {
      expect(deviceE2eeFailureAction(failure)).toEqual({
        closeCode: 4403,
        closeReason: 'e2ee handshake required',
        sendInitialState: false,
      });
    },
  );
});
