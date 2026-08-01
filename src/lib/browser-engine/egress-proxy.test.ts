import { describe, expect, it, vi } from 'vitest';
import { assertPublicHttpUrl } from '@/lib/network/safe-url';
import { resolveValidateAndDial } from './egress-proxy';

describe('browser engine egress proxy', () => {
  it('refuses a private connect-time answer after request-time validation passed', async () => {
    const requestResolver = vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]);
    await expect(assertPublicHttpUrl('https://rebind.example/path', requestResolver))
      .resolves.toMatchObject({ hostname: 'rebind.example' });

    const connectResolver = vi.fn(async () => [{ address: '169.254.169.254', family: 4 }]);
    const dial = vi.fn();
    await expect(resolveValidateAndDial('public', 'rebind.example', 443, dial, connectResolver))
      .rejects.toThrow('private or non-routable');

    expect(requestResolver).toHaveBeenCalledOnce();
    expect(connectResolver).toHaveBeenCalledOnce();
    expect(dial).not.toHaveBeenCalled();
  });

  it('dials the exact stable public address returned by its single resolution', async () => {
    const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const dial = vi.fn(async (destination) => destination.address);

    await expect(resolveValidateAndDial('public', 'example.com', 443, dial, resolver))
      .resolves.toBe('93.184.216.34');
    expect(resolver).toHaveBeenCalledOnce();
    expect(dial).toHaveBeenCalledWith({
      hostname: 'example.com',
      address: '93.184.216.34',
      family: 4,
      port: 443,
    });
  });

  it('validates IPv6 literals without sending them back through DNS', async () => {
    const resolver = vi.fn();
    const dial = vi.fn(async (destination) => destination.address);

    await expect(resolveValidateAndDial('public', '[2606:4700:4700::1111]', 443, dial, resolver))
      .resolves.toBe('2606:4700:4700::1111');
    await expect(resolveValidateAndDial('public', '[::1]', 443, dial, resolver))
      .rejects.toThrow('private or non-routable');
    await expect(resolveValidateAndDial('capture', '[::1]', 443, dial, resolver))
      .resolves.toBe('::1');
    expect(resolver).not.toHaveBeenCalled();
  });
});
