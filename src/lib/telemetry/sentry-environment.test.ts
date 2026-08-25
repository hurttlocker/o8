import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSentryEnvironment } from './sentry-config';

// `process.env.NODE_ENV` is typed read-only, so assigning to it fails tsc even
// though it works at runtime. vi.stubEnv is the supported way to set it.
afterEach(() => {
  vi.unstubAllEnvs();
});

function env(values: { packaged?: string; devFrontend?: string; nodeEnv?: string }) {
  vi.stubEnv('O8_PACKAGED_APP', values.packaged ?? '');
  vi.stubEnv('O8_DEV_FRONTEND_URL', values.devFrontend ?? '');
  vi.stubEnv('NODE_ENV', values.nodeEnv ?? '');
}

describe('resolveSentryEnvironment (#1679)', () => {
  it('tags an installed signed build as production', () => {
    env({ packaged: '1', nodeEnv: 'production' });
    expect(resolveSentryEnvironment()).toBe('production');
  });

  it('tags the dev-bridge loop as development even though the app is packaged', () => {
    // The packaged app pointed at a local Next dev server: O8_PACKAGED_APP is
    // set, the DSN resolves, the SDK initializes — and every event used to
    // arrive tagged production next to real user crashes.
    env({ packaged: '1', nodeEnv: 'production', devFrontend: 'http://127.0.0.1:47120' });
    expect(resolveSentryEnvironment()).toBe('development');
  });

  it('tags an unpackaged local stack as development', () => {
    env({});
    expect(resolveSentryEnvironment()).toBe('development');
    env({ nodeEnv: 'development' });
    expect(resolveSentryEnvironment()).toBe('development');
  });

  it('tags a packaged build running a non-production NODE_ENV as development', () => {
    env({ packaged: '1', nodeEnv: 'development' });
    expect(resolveSentryEnvironment()).toBe('development');
  });

  it('ignores a blank dev-frontend value rather than treating it as set', () => {
    env({ packaged: '1', nodeEnv: 'production', devFrontend: '   ' });
    expect(resolveSentryEnvironment()).toBe('production');
  });
});
