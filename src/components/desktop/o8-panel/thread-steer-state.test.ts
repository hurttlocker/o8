// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { clearPendingThreadSteer, readPendingThreadSteer, savePendingThreadSteer } from './thread-steer-state';

describe('pending thread receipt restoration', () => {
  it('restores the exact message identity from the webview session after module startup', () => {
    const packet = 'packet-restored-after-reload';
    const request = { id: 'mutation-restored', message: 'Check this result' };
    sessionStorage.setItem(`o8:pending-thread-steer:${packet}`, JSON.stringify(request));
    expect(readPendingThreadSteer(packet)).toEqual(request);
    expect(readPendingThreadSteer('another-packet')).toBeNull();
  });

  it('keeps a newer pending message when a second detail returns an old receipt', () => {
    const packet = 'packet-two-details';
    savePendingThreadSteer(packet, { id: 'old', message: 'First message' });
    clearPendingThreadSteer(packet, 'old');
    savePendingThreadSteer(packet, { id: 'new', message: 'New unsettled message' });
    clearPendingThreadSteer(packet, 'old');
    expect(readPendingThreadSteer(packet)).toEqual({ id: 'new', message: 'New unsettled message' });
    expect(JSON.parse(sessionStorage.getItem(`o8:pending-thread-steer:${packet}`)!)).toEqual({ id: 'new', message: 'New unsettled message' });
    clearPendingThreadSteer(packet, 'new');
    expect(readPendingThreadSteer(packet)).toBeNull();
    expect(sessionStorage.getItem(`o8:pending-thread-steer:${packet}`)).toBeNull();
  });
});
