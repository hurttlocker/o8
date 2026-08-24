import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSentryEnvironment } from './sentry-config';

const KEYS = ['O8_PACKAGED_APP', 'O8_DEV_FRONTEND_URL', 'NODE_ENV'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('resolveSentryEnvironment (#1679)', () => {
  it('tags an installed signed build as production', () => {
    process.env.O8_PACKAGED_APP = '1';
    process.env.NODE_ENV = 'production';
    expect(resolveSentryEnvironment()).toBe('production');
  });

  it('tags the dev-bridge loop as development even though the app is packaged', () => {
    // The packaged app pointed at a local Next dev server: O8_PACKAGED_APP is
    // set, the DSN resolves, the SDK initializes — and every event used to
    // arrive tagged production next to real user crashes.
    process.env.O8_PACKAGED_APP = '1';
    process.env.NODE_ENV = 'production';
    process.env.O8_DEV_FRONTEND_URL = 'http://127.0.0.1:47120';
    expect(resolveSentryEnvironment()).toBe('development');
  });

  it('tags an unpackaged local stack as development', () => {
    expect(resolveSentryEnvironment()).toBe('development');
    process.env.NODE_ENV = 'development';
    expect(resolveSentryEnvironment()).toBe('development');
  });

  it('tags a packaged build running a non-production NODE_ENV as development', () => {
    process.env.O8_PACKAGED_APP = '1';
    process.env.NODE_ENV = 'development';
    expect(resolveSentryEnvironment()).toBe('development');
  });

  it('ignores a blank dev-frontend value rather than treating it as set', () => {
    process.env.O8_PACKAGED_APP = '1';
    process.env.NODE_ENV = 'production';
    process.env.O8_DEV_FRONTEND_URL = '   ';
    expect(resolveSentryEnvironment()).toBe('production');
  });
});
