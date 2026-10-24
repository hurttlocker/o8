import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('@clerk/nextjs/server'); vi.resetModules(); });

it('answers desktop health through the real middleware without loading the hosted identity SDK', async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', undefined);
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', undefined);
  vi.stubEnv('CLERK_SECRET_KEY', undefined);
  const imported = vi.fn();
  vi.doMock('@clerk/nextjs/server', () => { imported(); throw new Error('hosted SDK must stay unloaded'); });
  const { default: middleware } = await import('@/middleware');
  const request = new NextRequest('http://fixture.invalid/api/panel/status', { headers: { host: 'fixture.invalid' } });
  expect((await middleware(request))?.status).toBe(200);
  expect(imported).not.toHaveBeenCalled();
});

it('initializes hosted identity once before the first hosted request uses it', async () => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'fixture-publishable-key');
  vi.stubEnv('CLERK_SECRET_KEY', 'fixture-server-key');
  const imported = vi.fn();
  const wrap = vi.fn((handler: (auth: unknown, request: NextRequest) => Response) =>
    (request: NextRequest) => handler({}, request));
  vi.doMock('@clerk/nextjs/server', () => { imported(); return { clerkMiddleware: wrap }; });
  const { default: middleware } = await import('@/middleware');
  expect(imported).not.toHaveBeenCalled();
  const request = new NextRequest('http://fixture.invalid/api/panel/status', { headers: { host: 'fixture.invalid' } });
  const responses = await Promise.all([middleware(request), middleware(request)]);
  expect(responses.map(response => response?.status)).toEqual([200, 200]);
  expect(imported).toHaveBeenCalledOnce();
  expect(wrap).toHaveBeenCalledOnce();
  const denied = await middleware(new NextRequest('http://fixture.invalid/api/fixture-protected', {
    headers: { host: 'fixture.invalid' },
  }));
  expect(denied?.status).toBe(401);
});
