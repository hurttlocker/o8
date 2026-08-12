export type DeviceE2eeFailure = 'handshake_timeout' | 'handshake_init_failed';

export interface DeviceE2eeFailureAction {
  closeCode: 4403;
  closeReason: 'e2ee handshake required';
  sendInitialState: false;
}

/** Enrolled device credentials always require proof of the registered device key. */
export function deviceE2eeFailureAction(failure: DeviceE2eeFailure): DeviceE2eeFailureAction {
  void failure;
  return {
    closeCode: 4403,
    closeReason: 'e2ee handshake required',
    sendInitialState: false,
  };
}
