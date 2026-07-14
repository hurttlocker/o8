import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPackaged, resolveSentryConfig, resolveSentryDsn } from './sentry-config';
import { initSentryNode } from './sentry-node';

/**
 * Proves the "ship it dormant" contract: with no DSN present (the default in the
 * isolated test env — O8_PACKAGED_APP is never set), every Sentry layer no-ops.
 * A DSN in env is ALSO gated on packaged, so dev / dev-bridge runs stay silent.
 */
describe('sentry — dormant without a DSN', () => {
  let packagedBefore: string | undefined;
  let dsnBefore: string | undefined;

  beforeEach(() => {
    packagedBefore = process.env.O8_PACKAGED_APP;
    dsnBefore = process.env.O8_SENTRY_DSN;
    delete process.env.O8_PACKAGED_APP;
    delete process.env.O8_SENTRY_DSN;
  });

  afterEach(() => {
    if (packagedBefore === undefined) delete process.env.O8_PACKAGED_APP;
    else process.env.O8_PACKAGED_APP = packagedBefore;
    if (dsnBefore === undefined) delete process.env.O8_SENTRY_DSN;
    else process.env.O8_SENTRY_DSN = dsnBefore;
  });

  it('resolveSentryDsn is empty when not packaged', () => {
    expect(isPackaged()).toBe(false);
    expect(resolveSentryDsn()).toBe('');
  });

  it('a DSN in env still resolves empty in a non-packaged (dev / dev-bridge) build', () => {
    const prev = process.env.O8_SENTRY_DSN;
    process.env.O8_SENTRY_DSN = 'https://public@o0.ingest.sentry.io/1';
    try {
      expect(resolveSentryDsn()).toBe(''); // gated on O8_PACKAGED_APP
    } finally {
      if (prev === undefined) delete process.env.O8_SENTRY_DSN;
      else process.env.O8_SENTRY_DSN = prev;
    }
  });

  it('resolveSentryConfig reports dormant with production defaults + a boolean founder', () => {
    const cfg = resolveSentryConfig();
    expect(cfg.dsn).toBe('');
    expect(cfg.environment).toBe('production');
    expect(cfg.enabled).toBe(false); // reporting requires an explicit opt-in
    expect(typeof cfg.founder).toBe('boolean');
    expect(cfg.release.length).toBeGreaterThan(0);
  });

  it('initSentryNode returns false and never loads @sentry/node without a DSN', async () => {
    await expect(initSentryNode('server')).resolves.toBe(false);
    await expect(initSentryNode('ws')).resolves.toBe(false);
  });
});
