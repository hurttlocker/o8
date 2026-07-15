import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, assertPublicWebSocketUrl, isPublicNetworkAddress } from './safe-url';

describe('public network URL validation', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.2',
    '169.254.169.254',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:a00:1',
    '::ffff:ac10:1',
    '::ffff:c0a8:101',
  ])('rejects private, metadata, and loopback addresses: %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public addresses: %s',
    (address) => expect(isPublicNetworkAddress(address)).toBe(true),
  );

  it('rejects mixed DNS answers rather than trusting the first address', async () => {
    await expect(assertPublicHttpUrl('https://rebind.example/path', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow('private or non-routable');
  });

  it('accepts an HTTPS URL only when every answer is public', async () => {
    const url = await assertPublicHttpUrl('https://example.test/path', async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(url.toString()).toBe('https://example.test/path');
  });

  it.each([
    'http://localhost:3000',
    'http://169.254.169.254/latest',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'file:///etc/passwd',
  ])(
    'rejects unsafe browser targets: %s',
    async (url) => expect(assertPublicHttpUrl(url, async () => [])).rejects.toThrow(),
  );

  it.each([
    'ws://localhost:47125',
    'ws://127.0.0.1:47125',
    'wss://169.254.169.254/socket',
    'ws://[::1]/socket',
    'https://example.test/socket',
  ])(
    'rejects unsafe or non-WebSocket browser targets: %s',
    async (url) => expect(assertPublicWebSocketUrl(url, async () => [])).rejects.toThrow(),
  );

  it('accepts a WebSocket only when every DNS answer is public', async () => {
    const url = await assertPublicWebSocketUrl('wss://socket.example.test/live', async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(url.toString()).toBe('wss://socket.example.test/live');

    await expect(assertPublicWebSocketUrl('wss://rebind.example.test/live', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ])).rejects.toThrow('private or non-routable');
  });
});
